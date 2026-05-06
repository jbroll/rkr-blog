// Admin SPA: TipTap editor wired to /admin/upload (image insertion) and
// /admin/posts (save). The editor never shows markdown to the user; the
// server-side prose-markdown converter handles serialization both ways.

import { Editor, mergeAttributes, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

interface ImageAttrs {
  id: string | null;
  alt: string | null;
}

interface SaveResponse {
  slug: string;
  inserted: boolean;
}

interface UploadResponse {
  id: string;
  bytes: number;
  ext: string;
  deduplicated: boolean;
}

interface GdriveStatus {
  connected: boolean;
}

interface GdriveAccessToken {
  accessToken: string;
  expiresAt: string;
}

interface GdrivePickerConfig {
  clientId: string;
  developerKey: string;
  appId: string;
}

// Minimal type shims for the Google Picker / gapi globals. Loaded
// dynamically at runtime; we don't ship @types/google.picker because
// the imports here are intentionally narrow.
interface PickerDoc {
  id: string;
  name?: string;
  mimeType?: string;
}
interface PickerResponseShape {
  action: string;
  docs?: PickerDoc[];
}
interface PickerInstance {
  setVisible(visible: boolean): void;
}
interface PickerBuilder {
  addView(view: unknown): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setCallback(cb: (data: PickerResponseShape) => void): PickerBuilder;
  build(): PickerInstance;
}
interface GoogleGlobal {
  picker: {
    PickerBuilder: new () => PickerBuilder;
    DocsView: new (viewId?: unknown) => unknown;
    ViewId: { DOCS_IMAGES: unknown };
    Action: { PICKED: string };
  };
}
interface GapiGlobal {
  load(name: string, callback: () => void): void;
}

// Custom image node. Stores {id, alt} in the document; renders to an
// <img> tag pointing at one of the image widget's preview URLs. Server
// sees this as a `::image{#id alt="..."}` directive after serialization.
const ImageNode = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      id: { default: null },
      alt: { default: null }
    };
  },
  parseHTML() {
    return [{ tag: 'img.rkr-image[data-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    const id = (HTMLAttributes as { id?: string }).id ?? '';
    const alt = (HTMLAttributes as { alt?: string }).alt ?? '';
    return [
      'img',
      mergeAttributes(HTMLAttributes, {
        class: 'rkr-image',
        'data-id': id,
        src: id ? `/img/${id}.preview.webp` : '',
        alt
      })
    ];
  }
});

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

function setStatus(msg: string): void {
  $('rkroll-admin-status').textContent = msg;
}

function makeButton(label: string, onClick: () => void, name?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (name) b.dataset.cmd = name;
  b.addEventListener('click', onClick);
  return b;
}

async function uploadImage(file: File): Promise<UploadResponse> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/admin/upload', { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return (await res.json()) as UploadResponse;
}

// ---- Google Drive picker helpers --------------------------------------

const GAPI_SRC = 'https://apis.google.com/js/api.js';

let gapiLoading: Promise<GapiGlobal> | null = null;
let pickerLoading: Promise<GoogleGlobal['picker']> | null = null;

function loadGapi(): Promise<GapiGlobal> {
  if (gapiLoading) return gapiLoading;
  gapiLoading = new Promise<GapiGlobal>((resolve, reject) => {
    const w = window as unknown as { gapi?: GapiGlobal };
    if (w.gapi) {
      resolve(w.gapi);
      return;
    }
    const script = document.createElement('script');
    script.src = GAPI_SRC;
    script.async = true;
    script.onload = () => {
      const loaded = (window as unknown as { gapi?: GapiGlobal }).gapi;
      if (loaded) resolve(loaded);
      else reject(new Error('gapi global missing after script load'));
    };
    script.onerror = () => reject(new Error('failed to load gapi script'));
    document.head.appendChild(script);
  });
  return gapiLoading;
}

async function loadPicker(): Promise<GoogleGlobal['picker']> {
  if (pickerLoading) return pickerLoading;
  pickerLoading = (async () => {
    const gapi = await loadGapi();
    await new Promise<void>((resolve) => gapi.load('picker', () => resolve()));
    const google = (window as unknown as { google?: GoogleGlobal }).google;
    if (!google) throw new Error('google global missing after picker load');
    return google.picker;
  })();
  return pickerLoading;
}

async function gdriveStatus(): Promise<GdriveStatus> {
  const res = await fetch('/admin/integrations/gdrive/status');
  if (!res.ok) throw new Error(`status: ${res.status}`);
  return (await res.json()) as GdriveStatus;
}

async function gdriveAccessToken(): Promise<GdriveAccessToken> {
  const res = await fetch('/admin/integrations/gdrive/access-token');
  if (!res.ok) throw new Error(`access-token: ${res.status}`);
  return (await res.json()) as GdriveAccessToken;
}

async function gdrivePickerConfig(): Promise<GdrivePickerConfig> {
  const res = await fetch('/admin/integrations/gdrive/picker-config');
  if (!res.ok) throw new Error(`picker-config: ${res.status}`);
  return (await res.json()) as GdrivePickerConfig;
}

async function importGdriveFile(fileId: string): Promise<UploadResponse> {
  const res = await fetch('/admin/import/gdrive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId })
  });
  if (!res.ok) throw new Error(`import: ${res.status} ${await res.text()}`);
  return (await res.json()) as UploadResponse;
}

/**
 * Open Drive picker → on selection, import each chosen file and insert as
 * an image node in the editor. Resolves after every file has been imported.
 */
async function pickFromDrive(editor: Editor): Promise<void> {
  const status = await gdriveStatus();
  if (!status.connected) {
    if (confirm('Google Drive is not connected for your account. Open the connect flow now?')) {
      window.location.href = '/admin/integrations/gdrive/connect';
    }
    return;
  }

  const [token, config, picker] = await Promise.all([
    gdriveAccessToken(),
    gdrivePickerConfig(),
    loadPicker()
  ]);

  const view = new picker.DocsView(picker.ViewId.DOCS_IMAGES);
  const instance = new picker.PickerBuilder()
    .addView(view)
    .setOAuthToken(token.accessToken)
    .setDeveloperKey(config.developerKey)
    .setAppId(config.appId)
    .setCallback(async (data) => {
      if (data.action !== picker.Action.PICKED) return;
      const docs = data.docs ?? [];
      for (const doc of docs) {
        setStatus(`importing ${doc.name ?? doc.id} from Drive…`);
        try {
          const r = await importGdriveFile(doc.id);
          const alt = prompt(`Alt text for ${doc.name ?? doc.id}?`, '') ?? '';
          const attrs: ImageAttrs = { id: r.id, alt };
          editor.chain().focus().insertContent({ type: 'image', attrs }).run();
          setStatus(`imported ${doc.name ?? doc.id} (${r.bytes} bytes)`);
        } catch (err) {
          setStatus(`Drive import error: ${(err as Error).message}`);
        }
      }
    })
    .build();
  instance.setVisible(true);
}

// ---- end Drive helpers ------------------------------------------------

async function savePost(payload: {
  slug: string;
  title: string;
  status: 'draft' | 'published';
  body: unknown;
}): Promise<SaveResponse> {
  const res = await fetch('/admin/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`save failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as SaveResponse;
}

function mount(): void {
  const root = $('rkroll-admin-root');
  const toolbar = $('rkroll-admin-toolbar');
  const fileInput = $<HTMLInputElement>('rkr-image-input');

  const editor = new Editor({
    element: root,
    extensions: [StarterKit, ImageNode],
    content: '<p></p>',
    autofocus: 'end'
  });

  toolbar.replaceChildren(
    makeButton('B', () => editor.chain().focus().toggleBold().run(), 'bold'),
    makeButton('I', () => editor.chain().focus().toggleItalic().run(), 'italic'),
    makeButton('H2', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), 'h2'),
    makeButton('H3', () => editor.chain().focus().toggleHeading({ level: 3 }).run(), 'h3'),
    makeButton(
      'Link',
      () => {
        const url = prompt('URL?');
        if (!url) return;
        editor.chain().focus().setLink({ href: url }).run();
      },
      'link'
    ),
    makeButton('Image', () => fileInput.click(), 'image'),
    makeButton(
      'Drive',
      () => {
        void pickFromDrive(editor).catch((err: unknown) => {
          setStatus(`Drive: ${(err as Error).message}`);
        });
      },
      'gdrive'
    ),
    makeButton('Save', () => void handleSave(editor), 'save')
  );

  // Sync active states on selection change.
  editor.on('selectionUpdate', () => {
    for (const b of toolbar.querySelectorAll<HTMLButtonElement>('button[data-cmd]')) {
      const cmd = b.dataset.cmd;
      let active = false;
      if (cmd === 'bold') active = editor.isActive('bold');
      else if (cmd === 'italic') active = editor.isActive('italic');
      else if (cmd === 'h2') active = editor.isActive('heading', { level: 2 });
      else if (cmd === 'h3') active = editor.isActive('heading', { level: 3 });
      else if (cmd === 'link') active = editor.isActive('link');
      b.classList.toggle('is-active', active);
    }
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileInput.value = '';
    setStatus(`uploading ${file.name}…`);
    try {
      const result = await uploadImage(file);
      const alt = prompt('Alt text?', '') ?? '';
      const attrs: ImageAttrs = { id: result.id, alt };
      editor.chain().focus().insertContent({ type: 'image', attrs }).run();
      setStatus(
        `uploaded ${file.name} (${result.bytes} bytes${result.deduplicated ? ', dedup' : ''})`
      );
    } catch (err) {
      setStatus(`upload error: ${(err as Error).message}`);
    }
  });
}

async function handleSave(editor: Editor): Promise<void> {
  const slug = $<HTMLInputElement>('rkr-slug').value.trim();
  const title = $<HTMLInputElement>('rkr-title').value.trim();
  const status = $<HTMLSelectElement>('rkr-status').value as 'draft' | 'published';
  if (!slug || !title) {
    setStatus('slug and title are required');
    return;
  }
  setStatus('saving…');
  try {
    const json = editor.getJSON();
    const result = await savePost({ slug, title, status, body: json });
    setStatus(`saved /${result.slug}`);
  } catch (err) {
    setStatus(`save error: ${(err as Error).message}`);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
