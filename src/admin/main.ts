// Admin SPA: TipTap editor wired to /admin/upload (image insertion) and
// /admin/posts (save). The editor never shows markdown to the user; the
// server-side prose-markdown converter handles serialization both ways.

import { Editor, mergeAttributes, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Cropper from 'cropperjs';
// Cropper.js ships its CSS as a side-effect import; esbuild bundles it
// into static/admin/main.js (no separate CSS file at runtime).
import 'cropperjs/dist/cropper.css';

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
        // Only set title when there's a caption; an empty title attr
        // produces an empty hover bubble in some browsers.
        ...(attrs.caption ? { title: attrs.caption } : {})
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

const MULTI_KINDS: readonly MultiImageKind[] = ['gallery', 'carousel', 'diptych', 'triptych'];

/** Slot caps per kind. Diptych/triptych enforce a hard min/max here in the
 * editor for friendlier UX; the public widgets (src/widgets/diptych.ts)
 * silently truncate excess ids with an HTML comment as a defensive fallback. */
const SLOT_SPEC: Record<MultiImageKind, { min: number; max: number }> = {
  gallery: { min: 1, max: Number.POSITIVE_INFINITY },
  carousel: { min: 1, max: Number.POSITIVE_INFINITY },
  diptych: { min: 2, max: 2 },
  triptych: { min: 3, max: 3 }
};

interface MultiImageAttrs {
  ids: string;
  /** Per-image alts, comma-separated, parallel to ids. Empty entries
   * mean "no alt" (decorative). The textarea UI displays one alt per
   * line for clarity; the wire format on the prose node stays
   * comma-separated to match the rendered markdown. */
  alts: string;
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
        // Per-image alts, parallel to ids; comma-separated on the wire.
        alts: { default: '' },
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
      // Conditional spread keeps captionLine out of the array entirely
      // when empty; otherwise TipTap inserts an empty text node.
      return [
        'div',
        mergeAttributes(HTMLAttributes, {
          class: `rkr-multi rkr-${kind}-placeholder`,
          'data-kind': kind,
          'data-count': String(idList.length)
        }),
        ['div', { class: 'rkr-multi-label' }, `${kind} (${idList.length})`],
        ['div', { class: 'rkr-multi-thumbs' }, ...thumbs],
        ...(attrs.caption ? [['div', { class: 'rkr-multi-caption' }, attrs.caption]] : [])
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

// In series so a partial-batch failure doesn't dribble half the ids
// into the editor before throwing.
async function uploadMany(files: File[]): Promise<string[]> {
  const ids: string[] = [];
  for (const f of files) {
    setStatus(`uploading ${f.name} (${ids.length + 1}/${files.length})…`);
    const r = await uploadImage(f);
    ids.push(r.id);
  }
  return ids;
}

// `cancel` + focus-return fallback are both needed: browsers that
// don't fire `cancel` (older Safari/Firefox) only signal a dismissed
// picker via the focus event; without one of these the Promise hangs
// and the input leaks into the DOM.
function pickMany(): Promise<File[]> {
  return new Promise<File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    let settled = false;
    const finish = (files: File[]): void => {
      if (settled) return;
      settled = true;
      if (input.parentNode) input.parentNode.removeChild(input);
      resolve(files);
    };
    input.addEventListener('change', () => finish(input.files ? Array.from(input.files) : []), {
      once: true
    });
    input.addEventListener('cancel', () => finish([]), { once: true });
    // Focus-return fallback: browsers that don't fire `cancel` (older
    // Safari/Firefox) restore focus to the window when the picker closes
    // without a selection. Resolve empty after a short delay so we don't
    // race the change event.
    window.addEventListener('focus', () => setTimeout(() => finish([]), 300), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

// ---- Cropper helpers --------------------------------------------------
// The crop UI mounts Cropper.js on the existing /admin/preview/<id>
// (the JPEG fallback, ~150KB) rather than the original — small payload,
// fewer pixels to render. On save we scale display coords (Cropper
// returns them in the IMG element's natural-pixel space) back to
// original-pixel space using the sidecar's recorded width/height.

interface SidecarMeta {
  width: number | null;
  height: number | null;
  format: string | null;
  ops: Array<{ type: string; [k: string]: unknown }>;
}

async function fetchSidecarMeta(id: string): Promise<SidecarMeta> {
  const res = await fetch(`/admin/sidecar/${id}/meta`);
  if (!res.ok) throw new Error(`meta: ${res.status}`);
  return (await res.json()) as SidecarMeta;
}

type SidecarOp = { type: string; [k: string]: unknown };

async function replaceSidecarOps(id: string, ops: SidecarOp[]): Promise<void> {
  const res = await fetch(`/admin/sidecar/${id}/ops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ops })
  });
  if (!res.ok) throw new Error(`save: ${res.status} ${await res.text()}`);
}

/** Fetch current sidecar ops, run them through `mutator`, normalize the
 * result into canonical order, and save back. The canonical order is
 * [crop, rotate, flip, resample]; only one of crop/resample is kept
 * (latest wins), rotates are summed mod 360, flips are toggled per
 * axis. This keeps the chain small and deterministic regardless of
 * click order. */
async function mutateSidecarOps(
  id: string,
  mutator: (ops: SidecarOp[]) => SidecarOp[]
): Promise<void> {
  const meta = await fetchSidecarMeta(id);
  const next = canonicalizeOps(mutator(meta.ops));
  await replaceSidecarOps(id, next);
}

const OP_ORDER: Record<string, number> = { crop: 0, rotate: 1, flip: 2, resample: 3 };

function canonicalizeOps(ops: SidecarOp[]): SidecarOp[] {
  // Coalesce: keep at most one crop / resample (last wins), sum rotate
  // degrees mod 360, dedupe flip axes (each toggle cancels the previous
  // for that axis).
  let crop: SidecarOp | null = null;
  let resample: SidecarOp | null = null;
  let totalDegrees = 0;
  const flipAxes = new Set<string>();
  for (const op of ops) {
    if (op.type === 'crop') crop = op;
    else if (op.type === 'resample') resample = op;
    else if (op.type === 'rotate') totalDegrees += Number(op.degrees ?? 0);
    else if (op.type === 'flip') {
      const a = String(op.axis);
      if (flipAxes.has(a)) flipAxes.delete(a);
      else flipAxes.add(a);
    }
  }
  const out: SidecarOp[] = [];
  if (crop) out.push(crop);
  const norm = ((totalDegrees % 360) + 360) % 360;
  if (norm !== 0) out.push({ type: 'rotate', degrees: norm });
  for (const axis of flipAxes) out.push({ type: 'flip', axis });
  if (resample) out.push(resample);
  return out.sort((a, b) => (OP_ORDER[a.type] ?? 99) - (OP_ORDER[b.type] ?? 99));
}

/** Force the editor's <img> to refetch /admin/preview/<id> after a crop
 * change. The 302 target's URL changes (different ophash) so the browser
 * cache won't return the stale derivative — but the <img>'s already-set
 * src is unchanged, so without busting it the DOM keeps the old visual. */
function bustImagePreview(editor: Editor, id: string): void {
  const dom = editor.view.dom as HTMLElement;
  for (const img of dom.querySelectorAll<HTMLImageElement>(`img.rkr-image[data-id="${id}"]`)) {
    const base = `/admin/preview/${id}`;
    img.src = `${base}?v=${Date.now()}`;
  }
}

let activeCropper: Cropper | null = null;

async function openCropper(id: string, onSaved: () => void): Promise<void> {
  const dialog = $<HTMLDialogElement>('rkr-crop-modal');
  const stageImg = $<HTMLImageElement>('rkr-crop-img');
  const status = $<HTMLSpanElement>('rkr-crop-status');
  const cancelBtn = $<HTMLButtonElement>('rkr-crop-cancel');
  const saveBtn = $<HTMLButtonElement>('rkr-crop-save');

  status.textContent = 'loading…';
  let meta: SidecarMeta;
  try {
    meta = await fetchSidecarMeta(id);
  } catch (err) {
    setStatus(`crop: ${(err as Error).message}`);
    return;
  }
  if (!meta.width || !meta.height) {
    setStatus('crop: source image has no recorded dimensions');
    return;
  }

  // Force a fresh load of the preview so the cropper sees post-crop
  // changes if this image was just cropped.
  stageImg.src = `/admin/preview/${id}?v=${Date.now()}`;
  stageImg.onload = () => {
    if (activeCropper) activeCropper.destroy();
    // ratio of original-pixel space to displayed-pixel space; Cropper's
    // getData() returns numbers in IMG natural-pixel coords (= preview
    // dimensions), and we scale them by these ratios on save.
    const xRatio = (meta.width ?? 1) / stageImg.naturalWidth;
    const yRatio = (meta.height ?? 1) / stageImg.naturalHeight;
    activeCropper = new Cropper(stageImg, {
      viewMode: 1,
      autoCropArea: 1,
      background: false,
      ready: () => {
        status.textContent = `${meta.width}×${meta.height} original`;
      }
    });
    saveBtn.onclick = async (): Promise<void> => {
      if (!activeCropper) return;
      const data = activeCropper.getData(true); // rounded to integers
      const op = {
        type: 'crop',
        x: Math.max(0, Math.round(data.x * xRatio)),
        y: Math.max(0, Math.round(data.y * yRatio)),
        w: Math.round(data.width * xRatio),
        h: Math.round(data.height * yRatio)
      };
      saveBtn.disabled = true;
      status.textContent = 'saving…';
      try {
        await replaceSidecarOps(id, [op]);
        status.textContent = 'saved';
        closeCropper();
        onSaved();
        setStatus(`cropped ${id.slice(0, 8)}…`);
      } catch (err) {
        status.textContent = `save failed: ${(err as Error).message}`;
        saveBtn.disabled = false;
      }
    };
  };

  cancelBtn.onclick = (): void => closeCropper();
  dialog.addEventListener('close', () => closeCropper(), { once: true });
  dialog.showModal();
}

function closeCropper(): void {
  const dialog = $<HTMLDialogElement>('rkr-crop-modal');
  if (activeCropper) {
    activeCropper.destroy();
    activeCropper = null;
  }
  if (dialog.open) dialog.close();
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

// ---- OneDrive helpers --------------------------------------------------
// MVP: connect flow + manual file-id prompt. Full Microsoft File Picker
// SDK integration arrives once an MS Entra app is registered for this
// deployment; the server side (src/routes/integrations-onedrive.ts +
// src/lib/microsoft-graph.ts) is fully ready.

interface OneDriveStatus {
  connected: boolean;
}

async function oneDriveStatus(): Promise<OneDriveStatus> {
  const res = await fetch('/admin/integrations/onedrive/status');
  if (!res.ok) throw new Error(`status: ${res.status}`);
  return (await res.json()) as OneDriveStatus;
}

async function importOneDriveFile(fileId: string): Promise<UploadResponse> {
  const res = await fetch('/admin/import/onedrive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileId })
  });
  if (!res.ok) throw new Error(`import: ${res.status} ${await res.text()}`);
  return (await res.json()) as UploadResponse;
}

/**
 * MVP OneDrive insert: confirm connection, prompt for an item id (or
 * a OneDrive share link, from which we extract the id), import it,
 * insert as an image node. Replace with the Microsoft File Picker
 * SDK once the deployment has an MS Entra app registered — picker-
 * config endpoint is ready, only the JS SDK integration is missing.
 */
async function pickFromOneDrive(editor: Editor): Promise<void> {
  const status = await oneDriveStatus();
  if (!status.connected) {
    if (confirm('OneDrive is not connected for your account. Open the connect flow now?')) {
      window.location.href = '/admin/integrations/onedrive/connect';
    }
    return;
  }
  const input = prompt('OneDrive item id (or share link):', '');
  if (!input) return;
  const fileId = parseOneDriveId(input);
  if (!fileId) {
    setStatus('OneDrive: could not extract an item id from input');
    return;
  }
  setStatus(`importing ${fileId.slice(0, 12)}… from OneDrive`);
  try {
    const r = await importOneDriveFile(fileId);
    const attrs: ImageAttrs = { id: r.id, alt: '', caption: '', position: 'default' };
    editor.chain().focus().insertContent({ type: 'image', attrs }).run();
    setStatus(`imported from OneDrive (${r.bytes} bytes${r.deduplicated ? ', dedup' : ''})`);
  } catch (err) {
    setStatus(`OneDrive import error: ${(err as Error).message}`);
  }
}

/** Extract a OneDrive item id from a raw id, a share link, or a Graph
 * URL. Falls back to the input verbatim if it already looks like an id
 * (alphanumeric + a few separators). Returns null on garbage. */
function parseOneDriveId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // /drive/items/<id> form (Graph URL or share link path).
  const m = /\/items\/([A-Za-z0-9!_-]+)/.exec(trimmed);
  if (m) return m[1] ?? null;
  // Bare-ish id heuristic — OneDrive ids look like
  // "01ABCDE234XYZ..." or use base64-ish chars; accept conservatively.
  if (/^[A-Za-z0-9!_-]+$/.test(trimmed)) return trimmed;
  return null;
}

// ---- end OneDrive helpers ---------------------------------------------

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
  const attrCropBtn = $<HTMLButtonElement>('rkr-image-crop-btn');
  const attrRotateLBtn = $<HTMLButtonElement>('rkr-image-rotate-l-btn');
  const attrRotateRBtn = $<HTMLButtonElement>('rkr-image-rotate-r-btn');
  const attrFlipHBtn = $<HTMLButtonElement>('rkr-image-flip-h-btn');
  const attrFlipVBtn = $<HTMLButtonElement>('rkr-image-flip-v-btn');
  const attrResampleInput = $<HTMLInputElement>('rkr-image-resample');
  const attrResampleBtn = $<HTMLButtonElement>('rkr-image-resample-btn');
  const attrResetBtn = $<HTMLButtonElement>('rkr-image-reset-btn');

  const multiPanel = $<HTMLDivElement>('rkr-multi-attrs');
  const multiLabel = $<HTMLHeadingElement>('rkr-multi-attrs-label');
  const multiIds = $<HTMLInputElement>('rkr-multi-ids');
  const multiAlts = $<HTMLTextAreaElement>('rkr-multi-alts');
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
    const { min, max } = SLOT_SPEC[kind];
    if (files.length < min) {
      setStatus(`${kind} needs at least ${min} image(s); got ${files.length}`);
      return;
    }
    if (files.length > max) {
      setStatus(`${kind} accepts at most ${max}; using the first ${max}`);
    }
    try {
      const ids = await uploadMany(files.slice(0, max));
      const attrs: Record<string, unknown> = { ids: ids.join(','), alts: '', caption: '' };
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
    makeButton(
      'OneDrive',
      () => {
        void pickFromOneDrive(editor).catch((err: unknown) => {
          setStatus(`OneDrive: ${(err as Error).message}`);
        });
      },
      'onedrive'
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
      // Async: load sidecar ops, toggle the Reset button, and populate
      // the resample-width input from any existing resample op so the
      // author sees the current value rather than an empty placeholder.
      attrResetBtn.hidden = true;
      attrResampleInput.value = '';
      if (a.id) {
        void fetchSidecarMeta(a.id).then(
          (meta) => {
            attrResetBtn.hidden = meta.ops.length === 0;
            const resample = meta.ops.find((o) => o.type === 'resample');
            if (resample && typeof resample.w === 'number') {
              attrResampleInput.value = String(resample.w);
            }
          },
          () => {
            /* best-effort */
          }
        );
      }
    } else {
      attrPanel.hidden = true;
    }

    const activeMulti: MultiImageKind | null = MULTI_KINDS.find((k) => editor.isActive(k)) ?? null;
    if (activeMulti) {
      const a = editor.getAttributes(activeMulti) as Partial<MultiImageAttrs>;
      populating = true;
      multiLabel.textContent = `${activeMulti} attributes`;
      multiIds.value = a.ids ?? '';
      // Display alts one per line so the column position matches the
      // comma-separated wire format. Pad with blank lines so the count
      // matches the id count and authors see all slots.
      const idCount = (a.ids ?? '').split(',').filter((s) => s.trim().length > 0).length;
      const altsList = (a.alts ?? '').split(',').map((s) => s.trim());
      while (altsList.length < idCount) altsList.push('');
      multiAlts.value = altsList.slice(0, Math.max(idCount, altsList.length)).join('\n');
      // Cap the visible row count so a 30-image gallery doesn't shove
      // every other panel control off the bottom of the viewport. The
      // textarea is `resize: vertical` if the author needs more.
      multiAlts.rows = Math.min(8, Math.max(3, idCount));
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

  function activeImageId(): string | null {
    if (!editor.isActive('image')) return null;
    const a = editor.getAttributes('image') as Partial<ImageAttrs>;
    return a.id ?? null;
  }

  /** Wrap a sidecar mutation: refuse if no image is selected, refresh
   * the editor preview on success, surface errors to the status bar. */
  function runEdit(label: string, mutator: (ops: SidecarOp[]) => SidecarOp[]): void {
    const id = activeImageId();
    if (!id) return;
    void mutateSidecarOps(id, mutator).then(
      () => {
        bustImagePreview(editor, id);
        attrResetBtn.hidden = false;
        setStatus(`${label} ${id.slice(0, 8)}…`);
      },
      (err: unknown) => setStatus(`${label} failed: ${(err as Error).message}`)
    );
  }

  attrCropBtn.addEventListener('click', () => {
    const id = activeImageId();
    if (id) void openCropper(id, () => bustImagePreview(editor, id));
  });
  attrRotateLBtn.addEventListener('click', () =>
    runEdit('rotate', (ops) => [...ops, { type: 'rotate', degrees: -90 }])
  );
  attrRotateRBtn.addEventListener('click', () =>
    runEdit('rotate', (ops) => [...ops, { type: 'rotate', degrees: 90 }])
  );
  attrFlipHBtn.addEventListener('click', () =>
    runEdit('flip', (ops) => [...ops, { type: 'flip', axis: 'horizontal' }])
  );
  attrFlipVBtn.addEventListener('click', () =>
    runEdit('flip', (ops) => [...ops, { type: 'flip', axis: 'vertical' }])
  );
  attrResampleBtn.addEventListener('click', () => {
    const w = Math.floor(Number(attrResampleInput.value) || 0);
    if (w <= 0) {
      // Empty input clears any existing resample op.
      runEdit('resample cleared', (ops) => ops.filter((o) => o.type !== 'resample'));
      return;
    }
    runEdit('resample', (ops) => [
      ...ops.filter((o) => o.type !== 'resample'),
      { type: 'resample', w, fit: 'inside' }
    ]);
  });
  attrResetBtn.addEventListener('click', () => {
    const id = activeImageId();
    if (!id) return;
    void replaceSidecarOps(id, []).then(
      () => {
        bustImagePreview(editor, id);
        attrResetBtn.hidden = true;
        attrResampleInput.value = '';
        setStatus('edits reset');
      },
      (err: unknown) => setStatus(`reset failed: ${(err as Error).message}`)
    );
  });

  function commitMultiAttr(name: 'caption' | 'layout' | 'autoplay' | 'alts', value: string): void {
    if (populating) return;
    const activeKind: MultiImageKind | null = MULTI_KINDS.find((k) => editor.isActive(k)) ?? null;
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
  // Textarea is one-alt-per-line for clarity; serialize to the
  // comma-separated wire format before committing. Trailing blank
  // lines are preserved so an author who left a slot blank still gets
  // the right index alignment with ids.
  multiAlts.addEventListener('input', () =>
    commitMultiAttr(
      'alts',
      multiAlts.value
        .split('\n')
        .map((s) => s.trim())
        .join(',')
    )
  );

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
