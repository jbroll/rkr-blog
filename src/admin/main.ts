// Admin SPA: TipTap editor wired to /admin/upload (image insertion) and
// /admin/posts (save). The editor never shows markdown to the user; the
// server-side prose-markdown converter handles serialization both ways.

import { Editor, mergeAttributes, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

type ImagePosition = 'default' | 'full' | 'left' | 'right' | 'inline';

interface ImageAttrs {
  id: string | null;
  alt: string | null;
  caption: string | null;
  position: ImagePosition;
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

// Custom image node. Stores {id, alt, caption, position} in the document;
// renders to an <img> pointing at /admin/preview/<id> (server redirects
// to the actual cached derivative). Server sees this as
// `::image{#id alt=… caption=… position=…}` after serialization.
const ImageNode = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      id: { default: null },
      alt: { default: null },
      caption: { default: null },
      position: { default: 'default' }
    };
  },
  parseHTML() {
    return [{ tag: 'img.rkr-image[data-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    const attrs = HTMLAttributes as {
      id?: string;
      alt?: string;
      caption?: string;
      position?: ImagePosition;
    };
    const id = attrs.id ?? '';
    const alt = attrs.alt ?? '';
    const position = attrs.position ?? 'default';
    return [
      'img',
      mergeAttributes(HTMLAttributes, {
        class: `rkr-image rkr-pos-${position}`,
        'data-id': id,
        src: id ? `/admin/preview/${id}` : '',
        alt,
        title: attrs.caption ?? ''
      })
    ];
  }
});

// Multi-image directive nodes: gallery, carousel, diptych, triptych.
// Each is a block atom whose attrs round-trip through prose-markdown to
// the matching `::<kind>{...}` directive on the public side. The editor
// renders a placeholder containing thumbnail <img>s pointing at
// /admin/preview/<id> so the author sees which photos are included.
type MultiImageKind = 'gallery' | 'carousel' | 'diptych' | 'triptych';

interface MultiImageAttrs {
  ids: string;
  caption: string;
  layout?: string;
  autoplay?: number;
}

function makeMultiImageNode(kind: MultiImageKind) {
  return Node.create({
    name: kind,
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,
    addAttributes() {
      const base = {
        ids: { default: '' },
        caption: { default: '' }
      };
      if (kind === 'gallery') {
        return { ...base, layout: { default: 'justified' } };
      }
      if (kind === 'carousel') {
        return { ...base, autoplay: { default: 0 } };
      }
      return base;
    },
    parseHTML() {
      return [{ tag: `div.rkr-${kind}-placeholder` }];
    },
    renderHTML({ HTMLAttributes }) {
      const attrs = HTMLAttributes as Partial<MultiImageAttrs>;
      const idList = (attrs.ids ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const thumbs: unknown[] = idList.map((id) => [
        'img',
        { src: `/admin/preview/${id}`, alt: '', class: 'rkr-multi-thumb' }
      ]);
      const captionLine = attrs.caption
        ? ['div', { class: 'rkr-multi-caption' }, attrs.caption]
        : '';
      return [
        'div',
        mergeAttributes(HTMLAttributes, {
          class: `rkr-multi rkr-${kind}-placeholder`,
          'data-kind': kind,
          'data-count': String(idList.length)
        }),
        ['div', { class: 'rkr-multi-label' }, `${kind} (${idList.length})`],
        ['div', { class: 'rkr-multi-thumbs' }, ...thumbs],
        captionLine
      ];
    }
  });
}

const GalleryNode = makeMultiImageNode('gallery');
const CarouselNode = makeMultiImageNode('carousel');
const DiptychNode = makeMultiImageNode('diptych');
const TriptychNode = makeMultiImageNode('triptych');

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

/** Upload a list of files in series, returning the ids in input order.
 * Errors abort the batch — partial state stays out of the editor. */
async function uploadMany(files: File[]): Promise<string[]> {
  const ids: string[] = [];
  for (const f of files) {
    setStatus(`uploading ${f.name} (${ids.length + 1}/${files.length})…`);
    const r = await uploadImage(f);
    ids.push(r.id);
  }
  return ids;
}

/** Open a hidden file input with `multiple` set, await the user's
 * selection, and resolve to the chosen File array (empty if cancelled). */
function pickMany(): Promise<File[]> {
  return new Promise<File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    input.addEventListener(
      'change',
      () => {
        const files = input.files ? Array.from(input.files) : [];
        document.body.removeChild(input);
        resolve(files);
      },
      { once: true }
    );
    document.body.appendChild(input);
    input.click();
  });
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
          const attrs: ImageAttrs = { id: r.id, alt: '', caption: '', position: 'default' };
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
  // Mount inside the <article> child so site.css's prose typography
  // (max-width, headings, blockquote, hr, code) applies to the editable
  // region. The outer #rkroll-admin-root keeps the framed-box look.
  const root = $('rkroll-admin-article');
  const toolbar = $('rkroll-admin-toolbar');
  const fileInput = $<HTMLInputElement>('rkr-image-input');
  const attrPanel = $<HTMLDivElement>('rkr-image-attrs');
  const attrAlt = $<HTMLInputElement>('rkr-image-alt');
  const attrCaption = $<HTMLInputElement>('rkr-image-caption');
  const attrPosition = $<HTMLSelectElement>('rkr-image-position');

  const multiPanel = $<HTMLDivElement>('rkr-multi-attrs');
  const multiLabel = $<HTMLHeadingElement>('rkr-multi-attrs-label');
  const multiIds = $<HTMLInputElement>('rkr-multi-ids');
  const multiCaption = $<HTMLInputElement>('rkr-multi-caption');
  const multiLayout = $<HTMLSelectElement>('rkr-multi-layout');
  const multiLayoutLabel = $<HTMLLabelElement>('rkr-multi-layout-label');
  const multiAutoplay = $<HTMLInputElement>('rkr-multi-autoplay');
  const multiAutoplayLabel = $<HTMLLabelElement>('rkr-multi-autoplay-label');

  const editor = new Editor({
    element: root,
    extensions: [StarterKit, ImageNode, GalleryNode, CarouselNode, DiptychNode, TriptychNode],
    content: '<p></p>',
    autofocus: 'end'
  });

  async function insertMultiImage(kind: MultiImageKind): Promise<void> {
    const files = await pickMany();
    if (files.length === 0) return;
    const min = kind === 'diptych' ? 2 : kind === 'triptych' ? 3 : 1;
    const max = kind === 'diptych' ? 2 : kind === 'triptych' ? 3 : Number.POSITIVE_INFINITY;
    if (files.length < min) {
      setStatus(`${kind} needs at least ${min} image(s); got ${files.length}`);
      return;
    }
    if (files.length > max) {
      setStatus(`${kind} accepts at most ${max}; using the first ${max}`);
    }
    try {
      const ids = await uploadMany(files.slice(0, max));
      const attrs: Record<string, unknown> = { ids: ids.join(','), caption: '' };
      if (kind === 'gallery') attrs.layout = 'justified';
      if (kind === 'carousel') attrs.autoplay = 0;
      editor.chain().focus().insertContent({ type: kind, attrs }).run();
      setStatus(`inserted ${kind} with ${ids.length} image(s)`);
    } catch (err) {
      setStatus(`${kind} insert failed: ${(err as Error).message}`);
    }
  }

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
    makeButton('Gallery', () => void insertMultiImage('gallery'), 'gallery'),
    makeButton('Carousel', () => void insertMultiImage('carousel'), 'carousel'),
    makeButton('Diptych', () => void insertMultiImage('diptych'), 'diptych'),
    makeButton('Triptych', () => void insertMultiImage('triptych'), 'triptych'),
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

  // Sync active states on selection change. Also reveals the image-
  // attribute panel when an image node is selected so the author can
  // edit alt / caption / position. Programmatic updates from the panel
  // re-trigger this handler; we guard against feedback loops via
  // `populating`.
  let populating = false;
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

    if (editor.isActive('image')) {
      const a = editor.getAttributes('image') as Partial<ImageAttrs>;
      populating = true;
      attrAlt.value = a.alt ?? '';
      attrCaption.value = a.caption ?? '';
      attrPosition.value = a.position ?? 'default';
      populating = false;
      attrPanel.hidden = false;
    } else {
      attrPanel.hidden = true;
    }

    const activeMulti: MultiImageKind | null =
      (['gallery', 'carousel', 'diptych', 'triptych'] as MultiImageKind[]).find((k) =>
        editor.isActive(k)
      ) ?? null;
    if (activeMulti) {
      const a = editor.getAttributes(activeMulti) as Partial<MultiImageAttrs>;
      populating = true;
      multiLabel.textContent = `${activeMulti} attributes`;
      multiIds.value = a.ids ?? '';
      multiCaption.value = a.caption ?? '';
      const showLayout = activeMulti === 'gallery';
      multiLayout.style.display = showLayout ? '' : 'none';
      multiLayoutLabel.style.display = showLayout ? '' : 'none';
      if (showLayout) multiLayout.value = a.layout ?? 'justified';
      const showAutoplay = activeMulti === 'carousel';
      multiAutoplay.style.display = showAutoplay ? '' : 'none';
      multiAutoplayLabel.style.display = showAutoplay ? '' : 'none';
      if (showAutoplay) multiAutoplay.value = String(a.autoplay ?? 0);
      populating = false;
      multiPanel.hidden = false;
    } else {
      multiPanel.hidden = true;
    }
  });

  function commitAttr(name: 'alt' | 'caption' | 'position', value: string): void {
    if (populating || !editor.isActive('image')) return;
    editor
      .chain()
      .focus()
      .updateAttributes('image', { [name]: value })
      .run();
  }
  attrAlt.addEventListener('input', () => commitAttr('alt', attrAlt.value));
  attrCaption.addEventListener('input', () => commitAttr('caption', attrCaption.value));
  attrPosition.addEventListener('change', () => commitAttr('position', attrPosition.value));

  function commitMultiAttr(name: 'caption' | 'layout' | 'autoplay', value: string): void {
    if (populating) return;
    const activeKind: MultiImageKind | null =
      (['gallery', 'carousel', 'diptych', 'triptych'] as MultiImageKind[]).find((k) =>
        editor.isActive(k)
      ) ?? null;
    if (!activeKind) return;
    const v: unknown = name === 'autoplay' ? Math.max(0, Math.floor(Number(value) || 0)) : value;
    editor
      .chain()
      .focus()
      .updateAttributes(activeKind, { [name]: v })
      .run();
  }
  multiCaption.addEventListener('input', () => commitMultiAttr('caption', multiCaption.value));
  multiLayout.addEventListener('change', () => commitMultiAttr('layout', multiLayout.value));
  multiAutoplay.addEventListener('input', () => commitMultiAttr('autoplay', multiAutoplay.value));

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileInput.value = '';
    setStatus(`uploading ${file.name}…`);
    try {
      const result = await uploadImage(file);
      // Insert with empty attrs; author edits via the image-attribute
      // panel that auto-reveals when the inserted node is selected.
      const attrs: ImageAttrs = { id: result.id, alt: '', caption: '', position: 'default' };
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
