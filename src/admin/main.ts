// Admin SPA: TipTap editor wired to /admin/upload (image insertion) and
// /admin/posts (save). The editor never shows markdown to the user;
// proseToMarkdown converts on save before POSTing — the server-side
// /admin/posts endpoint just persists the markdown after validation.

import { Editor, mergeAttributes, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Cropper from 'cropperjs';
// Cropper.js ships its CSS as a side-effect import; esbuild bundles it
// into static/admin/main.js (no separate CSS file at runtime).
import 'cropperjs/dist/cropper.css';

import { type ProseDoc, proseToMarkdown } from '../lib/prose-markdown.ts';
import { PipelineCache, type SidecarOp } from './canvas';
import { canonicalJson, computeHomography, perspectiveOutputSize } from './canvas-math';

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
  ops: SidecarOp[];
  redoStack: SidecarOp[];
}

async function fetchSidecarMeta(id: string): Promise<SidecarMeta> {
  const res = await fetch(`/admin/sidecar/${id}/meta`);
  if (!res.ok) throw new Error(`meta: ${res.status}`);
  return (await res.json()) as SidecarMeta;
}

// ---- Local edit state -------------------------------------------------
// Edits live in the browser until the user hits "Save edits". Each
// click (rotate / flip / crop / resample / undo / redo / delete-step /
// reset) mutates this in-memory state and re-renders the preview via
// the canvas pipeline. No server round-trip per click.
//
// Save commits ops + redoStack to /admin/sidecar/:id/ops AND uploads
// the baked WebP to /admin/sidecar/:id/bake. `baseline` tracks what
// the server has so we can detect "dirty" (Save button enabled) and
// undo unsaved local edits if needed.

interface LocalEditState {
  ops: SidecarOp[];
  redoStack: SidecarOp[];
  /** Last server-known state. Update on Save. Used for dirty check. */
  baseline: {
    ops: SidecarOp[];
    redoStack: SidecarOp[];
  };
  /** Source dimensions, copied from the sidecar metadata. Used by the
   * cropper to set up its display ratio. */
  sourceWidth: number | null;
  sourceHeight: number | null;
}

const localEditState = new Map<string, LocalEditState>();

/** Lazy-load the local state for an id from the server. Subsequent
 * accesses reuse the cached state, preserving any in-progress edits
 * across selection changes. */
async function ensureLocalState(id: string): Promise<LocalEditState> {
  const cached = localEditState.get(id);
  if (cached) return cached;
  const meta = await fetchSidecarMeta(id);
  const fresh: LocalEditState = {
    ops: [...meta.ops],
    redoStack: [...meta.redoStack],
    baseline: { ops: [...meta.ops], redoStack: [...meta.redoStack] },
    sourceWidth: meta.width,
    sourceHeight: meta.height
  };
  localEditState.set(id, fresh);
  return fresh;
}

function isDirty(s: LocalEditState): boolean {
  // Use canonicalJson rather than JSON.stringify so two semantically
  // equivalent op chains compare equal regardless of object-key
  // insertion order — ops can be built by the cropper, the perspective
  // modal, runEdit, or the round-tripped server response, each of
  // which may emit keys in a different order.
  return (
    canonicalJson(s.ops) !== canonicalJson(s.baseline.ops) ||
    canonicalJson(s.redoStack) !== canonicalJson(s.baseline.redoStack)
  );
}

/** Mutate the local ops in place; clear redoStack (any new op
 * invalidates redo history, the standard linear-undo invariant). */
function localMutate(s: LocalEditState, mutator: (ops: SidecarOp[]) => SidecarOp[]): void {
  s.ops = mutator(s.ops);
  s.redoStack = [];
}

function localUndo(s: LocalEditState): void {
  if (s.ops.length === 0) return;
  const popped = s.ops[s.ops.length - 1] as SidecarOp;
  s.ops = s.ops.slice(0, -1);
  s.redoStack = [...s.redoStack, popped];
}

function localRedo(s: LocalEditState): void {
  if (s.redoStack.length === 0) return;
  const popped = s.redoStack[s.redoStack.length - 1] as SidecarOp;
  s.ops = [...s.ops, popped];
  s.redoStack = s.redoStack.slice(0, -1);
}

function localDeleteAt(s: LocalEditState, index: number): void {
  if (index < 0 || index >= s.ops.length) return;
  s.ops = [...s.ops.slice(0, index), ...s.ops.slice(index + 1)];
}

/** Server-side commit of one image's local edits. Used by the Save
 * button. Posts ops + redoStack first (so the server unlinks any prior
 * bake), then if there are still ops uploads the freshly baked WebP. */
async function postOpsToServer(
  id: string,
  ops: SidecarOp[],
  redoStack: SidecarOp[]
): Promise<void> {
  const res = await fetch(`/admin/sidecar/${id}/ops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ops, redoStack })
  });
  if (!res.ok) throw new Error(`ops: ${res.status} ${await res.text()}`);
}

/** Commit one image's local edits to the server: POST ops + redoStack
 * (which unlinks any prior bake), then if there's still ops to bake,
 * apply them on the master and POST the WebP to /bake. Update baseline
 * only after both calls land — partial commits stay dirty so a retry
 * picks them up. */
async function saveImageEdits(id: string, s: LocalEditState): Promise<void> {
  // Snapshot the prior server-known state before mutating: if /ops
  // succeeds but /bake fails, we restore the snapshot so the public
  // site doesn't end up serving 500s for an `ops` chain whose bake
  // never landed (notably, `perspective` is client-only — sharp can't
  // apply a homography, so a missing bake means `unknown op type`
  // until the next save).
  const priorOps = [...s.baseline.ops];
  const priorRedo = [...s.baseline.redoStack];

  await postOpsToServer(id, s.ops, s.redoStack);
  if (s.ops.length > 0) {
    try {
      const original = await loadOriginal(id);
      const canvas = getPipelineCache(id).apply(
        {
          drawable: original,
          width: original.naturalWidth,
          height: original.naturalHeight
        },
        s.ops
      );
      const blob = await canvasToBlob(canvas, 'image/webp', 0.95);
      await uploadBake(id, blob);
    } catch (err) {
      // Roll back the server's view of ops to the prior baseline so
      // the public site stays in a coherent state. Best-effort: if
      // this also fails the user's session is offline — the local
      // state stays dirty for retry, and beforeunload will warn
      // before the user loses work to a reload.
      await postOpsToServer(id, priorOps, priorRedo).catch(() => {
        /* network gone; user retries */
      });
      throw err;
    }
  }
  s.baseline = { ops: [...s.ops], redoStack: [...s.redoStack] };
}

/** Snapshot the in-memory edit state for every image whose local ops
 * differ from server baseline. The post-Save flow auto-commits these
 * before writing the markdown, and `beforeunload` blocks reload while
 * any are present. */
function dirtyImageStates(): Array<[string, LocalEditState]> {
  const out: Array<[string, LocalEditState]> = [];
  for (const [id, s] of localEditState) {
    if (isDirty(s)) out.push([id, s]);
  }
  return out;
}

/** Save every dirty image's edits in parallel via Promise.allSettled.
 * Returns counts so the caller can surface progress; rejected promises
 * leave `baseline` untouched (image stays dirty). */
async function flushDirtyImageEdits(): Promise<{ ok: number; failed: number }> {
  const dirty = dirtyImageStates();
  if (dirty.length === 0) return { ok: 0, failed: 0 };
  const results = await Promise.allSettled(dirty.map(([id, s]) => saveImageEdits(id, s)));
  let ok = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') ok++;
    else failed++;
  }
  return { ok, failed };
}

/** Human-readable label for one op, used in the edits list under the
 * image-attributes panel. Tries to format coords / dimensions in a way
 * the author can scan ("crop 400×300 @ 100,50"); falls back to the raw
 * type for anything we don't recognize. */
function describeOp(op: SidecarOp): string {
  switch (op.type) {
    case 'crop': {
      const w = Number(op.w) || 0;
      const h = Number(op.h) || 0;
      const x = Number(op.x) || 0;
      const y = Number(op.y) || 0;
      return `crop ${w}×${h} @ ${x},${y}`;
    }
    case 'rotate':
      return `rotate ${String(op.degrees)}°`;
    case 'flip':
      return `flip ${String(op.axis)}`;
    case 'resample':
      return `resample max-w ${String(op.w)}`;
    case 'perspective': {
      const c = op.corners;
      const n = Array.isArray(c) ? c.length : 0;
      return `perspective ${n}-corner`;
    }
    default:
      return op.type;
  }
}

// Client-side preview pipeline: download the master once, decode it,
// apply ops in-browser via canvas, swap the <img src> to a Blob URL.
// Avoids a server round-trip per click. Falls back to the server-baked
// preview when the browser can't decode the format (notably HEIC).

/** Per-image cache cap. A 24-MP decoded HTMLImageElement is ~100 MB;
 * a PipelineCache canvas is similarly heavy. Cap session-resident
 * images so a long edit session that touches many photos doesn't
 * grow without bound. localEditState is intentionally NOT capped —
 * its entries are tiny JSON and evicting a dirty entry would silently
 * drop the user's unsaved work. */
const IMAGE_CACHE_CAP = 16;

/** Read with LRU bump: re-inserts the entry so it becomes the
 * most-recently-used. Map preserves insertion order, so the oldest
 * entry is `keys().next().value`. */
function lruGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key);
  if (value !== undefined) {
    map.delete(key);
    map.set(key, value);
  }
  return value;
}

/** Insert (or move-to-most-recent), then evict the oldest entries
 * until size is at or below `cap`. `onEvict` runs for each evicted
 * pair — used to revoke Blob URLs so the underlying Blob is freed. */
function lruSet<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  cap: number,
  onEvict?: (k: K, v: V) => void
): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next().value as K;
    const oldValue = map.get(oldest) as V;
    map.delete(oldest);
    onEvict?.(oldest, oldValue);
  }
}

const originalCache = new Map<string, Promise<HTMLImageElement>>();
const previewBlobUrls = new Map<string, string>();
// One pipeline cache per image id. On the common "added one op" case
// it lets us apply just the new op to the previously-cached canvas
// instead of re-executing the whole chain from the master. See
// canvas.ts → PipelineCache.
const pipelineCaches = new Map<string, PipelineCache>();

function getPipelineCache(id: string): PipelineCache {
  let c = lruGet(pipelineCaches, id);
  if (!c) {
    c = new PipelineCache();
    lruSet(pipelineCaches, id, c, IMAGE_CACHE_CAP);
  }
  return c;
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = (): void => resolve(img);
    img.onerror = (): void => reject(new Error(`decode failed for ${src}`));
    img.src = src;
  });
}

/** Fetch + decode the original master image. Cached per session per
 * id; cache is keyed on the Promise so concurrent callers share the
 * single in-flight fetch. */
function loadOriginal(id: string): Promise<HTMLImageElement> {
  const cached = lruGet(originalCache, id);
  if (cached) return cached;
  const p = (async (): Promise<HTMLImageElement> => {
    const res = await fetch(`/admin/original/${id}`);
    if (!res.ok) throw new Error(`original: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    try {
      return await loadImageElement(url);
    } finally {
      // Image element keeps its decoded buffer; we don't need the
      // blob URL alive past this point.
      URL.revokeObjectURL(url);
    }
  })();
  lruSet(originalCache, id, p, IMAGE_CACHE_CAP);
  // Don't cache failures — a transient 5xx shouldn't poison the
  // session. Compare-and-delete: if `p` has already been replaced by
  // a fresh load (eviction-then-reload race) we must NOT delete the
  // replacement.
  p.catch(() => {
    if (originalCache.get(id) === p) originalCache.delete(id);
  });
  return p;
}

/** Lazy WebGL availability probe. Cached because the answer doesn't
 * change at runtime — once a context is denied (older browser, WebGL
 * disabled by privacy tooling), it stays denied for the session. The
 * perspective button uses this at mount to disable up front rather
 * than letting a click silently no-op. */
let webglSupportCached: boolean | null = null;
function hasWebglSupport(): boolean {
  if (webglSupportCached !== null) return webglSupportCached;
  try {
    const probe = document.createElement('canvas');
    webglSupportCached = probe.getContext('webgl') !== null;
  } catch {
    webglSupportCached = false;
  }
  return webglSupportCached;
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b): void => (b ? resolve(b) : reject(new Error('toBlob: empty result'))),
      mime,
      quality
    );
  });
}

function setEditorImageSrc(editor: Editor, id: string, src: string): void {
  const dom = editor.view.dom as HTMLElement;
  for (const img of dom.querySelectorAll<HTMLImageElement>(`img.rkr-image[data-id="${id}"]`)) {
    img.src = src;
  }
}

/** Re-render the editor preview for one image. Tries client-side bake
 * first (canvas pipeline against the master); on any failure (decode
 * unsupported format, fetch error) falls back to the server-baked
 * /admin/preview/<id> with a cache-buster.
 *
 * Returns the produced WebP blob so the caller can upload it as the
 * server's bake; null when we fell back to the server-baked preview. */
async function refreshImagePreview(
  editor: Editor,
  id: string,
  ops: SidecarOp[]
): Promise<Blob | null> {
  try {
    const original = await loadOriginal(id);
    // Per-image pipeline cache: when the new ops list is the previous
    // list plus one appended op, only that op runs (cache.apply); any
    // other change re-executes from source.
    const canvas = getPipelineCache(id).apply(
      {
        drawable: original,
        width: original.naturalWidth,
        height: original.naturalHeight
      },
      ops
    );
    // WebP, not PNG: a 24MP camera image is ~30 MB as PNG vs ~2-3 MB as
    // WebP at q=0.95 with no perceptible quality loss.
    const blob = await canvasToBlob(canvas, 'image/webp', 0.95);
    const url = URL.createObjectURL(blob);
    // Revoke the prior URL for this id (if any) plus any URLs evicted
    // by the LRU cap — without this the underlying Blobs would stay
    // pinned in memory across the session.
    const old = previewBlobUrls.get(id);
    if (old) URL.revokeObjectURL(old);
    lruSet(previewBlobUrls, id, url, IMAGE_CACHE_CAP, (_k, v) => URL.revokeObjectURL(v));
    setEditorImageSrc(editor, id, url);
    return blob;
  } catch {
    // Fallback: ask the server. The cache-buster query forces a 302
    // re-resolve so a stale derivative URL isn't reused. The new ops
    // are already on the sidecar, so the server's /admin/preview will
    // resolve to a fresh derivative.
    setEditorImageSrc(editor, id, `/admin/preview/${id}?v=${Date.now()}`);
    return null;
  }
}

async function uploadBake(id: string, blob: Blob): Promise<void> {
  const res = await fetch(`/admin/sidecar/${id}/bake`, {
    method: 'POST',
    headers: { 'content-type': 'image/webp' },
    body: blob
  });
  if (!res.ok) throw new Error(`bake: ${res.status} ${await res.text()}`);
}

let activeCropper: Cropper | null = null;

async function openCropper(id: string, s: LocalEditState, onSaved: () => void): Promise<void> {
  const dialog = $<HTMLDialogElement>('rkr-crop-modal');
  const stageImg = $<HTMLImageElement>('rkr-crop-img');
  const status = $<HTMLSpanElement>('rkr-crop-status');
  const cancelBtn = $<HTMLButtonElement>('rkr-crop-cancel');
  const saveBtn = $<HTMLButtonElement>('rkr-crop-save');

  if (!s.sourceWidth || !s.sourceHeight) {
    setStatus('crop: source image has no recorded dimensions');
    return;
  }

  status.textContent = 'loading…';
  // Cropper sources from the LOCAL post-ops canvas, not the server's
  // preview. That way the user crops what they're actually looking at,
  // and the returned coords are already in current-canvas space —
  // applyCrop in the pipeline interprets them in that same space, so
  // crop appends correctly even after prior crops/rotates.
  let canvas: HTMLCanvasElement;
  try {
    const original = await loadOriginal(id);
    canvas = getPipelineCache(id).apply(
      {
        drawable: original,
        width: original.naturalWidth,
        height: original.naturalHeight
      },
      s.ops
    );
  } catch (err) {
    setStatus(`crop: ${(err as Error).message}`);
    return;
  }

  let blob: Blob;
  try {
    blob = await canvasToBlob(canvas, 'image/webp', 0.95);
  } catch (err) {
    setStatus(`crop: ${(err as Error).message}`);
    return;
  }
  const stageUrl = URL.createObjectURL(blob);
  stageImg.src = stageUrl;
  stageImg.onload = (): void => {
    if (activeCropper) activeCropper.destroy();
    activeCropper = new Cropper(stageImg, {
      viewMode: 1,
      autoCropArea: 1,
      background: false,
      ready: () => {
        status.textContent = `${canvas.width}×${canvas.height} current`;
      }
    });
    saveBtn.onclick = (): void => {
      if (!activeCropper) return;
      const data = activeCropper.getData(true); // rounded to integers
      // Cropper coords are in stageImg.natural space, which IS the
      // current canvas space. No scaling needed.
      const op: SidecarOp = {
        type: 'crop',
        x: Math.max(0, Math.round(data.x)),
        y: Math.max(0, Math.round(data.y)),
        w: Math.round(data.width),
        h: Math.round(data.height)
      };
      // Append to the existing op chain. Prior rotates / flips / etc
      // are preserved; the new crop operates on what they produced.
      localMutate(s, (ops) => [...ops, op]);
      status.textContent = 'saved';
      closeCropper();
      URL.revokeObjectURL(stageUrl);
      onSaved();
    };
  };

  cancelBtn.onclick = (): void => {
    closeCropper();
    URL.revokeObjectURL(stageUrl);
  };
  dialog.addEventListener(
    'close',
    () => {
      closeCropper();
      URL.revokeObjectURL(stageUrl);
    },
    { once: true }
  );
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

// ---- Perspective rectify modal ---------------------------------------
// Custom UI (no third-party lib): load the local post-ops canvas as
// the stage, place 4 absolutely-positioned handles over it (initially
// at the four image corners), let the user drag each, and on Save
// commit a perspective op whose corners are in current-canvas
// (post-prior-ops) space. The canvas pipeline's applyPerspective then
// runs a WebGL homography to rectify.

interface PerspSession {
  /** Canvas-pixel coords of the four handles, in tl/tr/br/bl order. */
  corners: [Point, Point, Point, Point];
  /** Source canvas dimensions in pixel space. */
  canvasW: number;
  canvasH: number;
  /** Cleanup hook; revokes the stage Blob URL and removes handles. */
  dispose: () => void;
}

type Point = [number, number];

let activePersp: PerspSession | null = null;

async function openPerspective(id: string, s: LocalEditState, onSaved: () => void): Promise<void> {
  const dialog = $<HTMLDialogElement>('rkr-persp-modal');
  const stage = $<HTMLDivElement>('rkr-persp-stage');
  const stageImg = $<HTMLImageElement>('rkr-persp-img');
  const svg = document.getElementById('rkr-persp-svg') as unknown as SVGSVGElement | null;
  const status = $<HTMLSpanElement>('rkr-persp-status');
  const cancelBtn = $<HTMLButtonElement>('rkr-persp-cancel');
  const saveBtn = $<HTMLButtonElement>('rkr-persp-save');
  if (!svg) {
    setStatus('perspective: SVG overlay missing');
    return;
  }
  const svgEl: SVGSVGElement = svg;

  // Build the post-ops canvas (current-state baseline for perspective).
  let canvas: HTMLCanvasElement;
  try {
    const original = await loadOriginal(id);
    canvas = getPipelineCache(id).apply(
      {
        drawable: original,
        width: original.naturalWidth,
        height: original.naturalHeight
      },
      s.ops
    );
  } catch (err) {
    setStatus(`perspective: ${(err as Error).message}`);
    return;
  }
  let blob: Blob;
  try {
    blob = await canvasToBlob(canvas, 'image/webp', 0.95);
  } catch (err) {
    setStatus(`perspective: ${(err as Error).message}`);
    return;
  }
  const stageUrl = URL.createObjectURL(blob);
  stageImg.src = stageUrl;

  // Initial handle positions: the four image corners in canvas pixel
  // space. Drag-to-reposition runs in stage pixel space; we convert at
  // commit time via the displayed image's bounding rect.
  const corners: [Point, Point, Point, Point] = [
    [0, 0],
    [canvas.width, 0],
    [canvas.width, canvas.height],
    [0, canvas.height]
  ];

  const handles: HTMLDivElement[] = [];
  for (let i = 0; i < 4; i++) {
    const h = document.createElement('div');
    h.className = 'rkr-persp-handle';
    h.dataset.idx = String(i);
    h.setAttribute('aria-label', `Corner ${i + 1}`);
    stage.appendChild(h);
    handles.push(h);
  }

  function imgRect(): DOMRect {
    return stageImg.getBoundingClientRect();
  }
  function stageRect(): DOMRect {
    return stage.getBoundingClientRect();
  }

  /** Map canvas-pixel coords → stage-pixel coords (for handle position
   * + svg). The displayed image is letterboxed inside the stage. */
  function canvasToStage(p: Point): [number, number] {
    const ir = imgRect();
    const sr = stageRect();
    const sx = p[0] * (ir.width / canvas.width) + (ir.left - sr.left);
    const sy = p[1] * (ir.height / canvas.height) + (ir.top - sr.top);
    return [sx, sy];
  }
  /** Map stage-pixel coords → canvas-pixel coords (commit direction). */
  function stageToCanvas(sx: number, sy: number): Point {
    const ir = imgRect();
    const sr = stageRect();
    const cx = ((sx - (ir.left - sr.left)) * canvas.width) / ir.width;
    const cy = ((sy - (ir.top - sr.top)) * canvas.height) / ir.height;
    // Clamp to canvas bounds; the user may drag outside.
    return [Math.max(0, Math.min(canvas.width, cx)), Math.max(0, Math.min(canvas.height, cy))];
  }

  function repaint(): void {
    for (let i = 0; i < 4; i++) {
      const c = corners[i] as Point;
      const [sx, sy] = canvasToStage(c);
      const h = handles[i] as HTMLDivElement;
      h.style.left = `${sx}px`;
      h.style.top = `${sy}px`;
    }
    // SVG quad: connect handles in order with a closed polygon.
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
    const ns = 'http://www.w3.org/2000/svg';
    const poly = document.createElementNS(ns, 'polygon');
    const points = corners
      .map((c) => {
        const [sx, sy] = canvasToStage(c);
        return `${sx},${sy}`;
      })
      .join(' ');
    poly.setAttribute('points', points);
    poly.setAttribute('fill', 'rgba(64, 128, 255, 0.15)');
    poly.setAttribute('stroke', 'rgba(64, 128, 255, 0.9)');
    poly.setAttribute('stroke-width', '2');
    svgEl.appendChild(poly);
  }

  // Pointer drag handling. We use Pointer Events for unified mouse +
  // touch + pen support.
  function onPointerDown(ev: PointerEvent): void {
    const target = ev.currentTarget as HTMLDivElement;
    const idx = Number(target.dataset.idx);
    if (!Number.isInteger(idx)) return;
    target.setPointerCapture(ev.pointerId);
    ev.preventDefault();

    function onMove(mv: PointerEvent): void {
      const sr = stageRect();
      corners[idx] = stageToCanvas(mv.clientX - sr.left, mv.clientY - sr.top);
      repaint();
    }
    function onUp(_up: PointerEvent): void {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    }
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }
  for (const h of handles) {
    h.addEventListener('pointerdown', onPointerDown);
  }

  function dispose(): void {
    URL.revokeObjectURL(stageUrl);
    for (const h of handles) h.remove();
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
  }
  activePersp = { corners, canvasW: canvas.width, canvasH: canvas.height, dispose };

  stageImg.onload = (): void => {
    repaint();
    status.textContent = `${canvas.width}×${canvas.height} current`;
  };

  // Refresh on resize (browser zoom, viewport changes).
  const onResize = (): void => repaint();
  window.addEventListener('resize', onResize);

  saveBtn.onclick = (): void => {
    // Validate the quad is non-degenerate (no three colinear points)
    // before committing: computeHomography returns null on a singular
    // linear system, applyPerspective would then no-op, and the user
    // would see no preview update with no explanation. Catch it here
    // and tell them why.
    const { w: outW, h: outH } = perspectiveOutputSize(corners);
    const dst: [Point, Point, Point, Point] = [
      [0, 0],
      [outW, 0],
      [outW, outH],
      [0, outH]
    ];
    if (!computeHomography(corners, dst)) {
      status.textContent = 'corners are degenerate (three colinear points?); adjust them';
      return;
    }
    const op: SidecarOp = {
      type: 'perspective',
      corners: corners.map((c) => [Math.round(c[0]), Math.round(c[1])])
    };
    localMutate(s, (ops) => [...ops, op]);
    closePerspective();
    window.removeEventListener('resize', onResize);
    onSaved();
  };
  cancelBtn.onclick = (): void => {
    closePerspective();
    window.removeEventListener('resize', onResize);
  };
  dialog.addEventListener(
    'close',
    () => {
      closePerspective();
      window.removeEventListener('resize', onResize);
    },
    { once: true }
  );
  dialog.showModal();
}

function closePerspective(): void {
  const dialog = $<HTMLDialogElement>('rkr-persp-modal');
  if (activePersp) {
    activePersp.dispose();
    activePersp = null;
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
  markdown: string;
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
  const attrPerspBtn = $<HTMLButtonElement>('rkr-image-perspective-btn');
  // Perspective rectify needs WebGL (Canvas2D's setTransform is affine
  // only, so a homography can't be applied without a fragment shader).
  // Detect at mount time and disable the button up front rather than
  // surprising the user with a silent no-op when they save the modal.
  if (!hasWebglSupport()) {
    attrPerspBtn.disabled = true;
    attrPerspBtn.title = 'Perspective rectify requires WebGL; your browser does not support it.';
  }
  const attrUndoBtn = $<HTMLButtonElement>('rkr-image-undo-btn');
  const attrRedoBtn = $<HTMLButtonElement>('rkr-image-redo-btn');
  const attrResampleInput = $<HTMLInputElement>('rkr-image-resample');
  const attrResampleBtn = $<HTMLButtonElement>('rkr-image-resample-btn');
  const attrResetBtn = $<HTMLButtonElement>('rkr-image-reset-btn');
  const attrSaveBtn = $<HTMLButtonElement>('rkr-image-save-btn');
  const attrEditsList = $<HTMLOListElement>('rkr-image-edits');

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
    autofocus: 'end',
    editorProps: {
      // Drag-and-drop: extract File[]s from the drop, upload them
      // sequentially, insert image nodes at the drop position. Return
      // true so ProseMirror skips its default drop handling (which
      // would otherwise insert garbage HTML for the dropped files).
      handleDrop: (view, ev, _slice, _moved): boolean => {
        const dt = (ev as DragEvent).dataTransfer;
        const files = dt ? imageFilesFrom(dt) : [];
        if (files.length === 0) return false;
        ev.preventDefault();
        const e = ev as DragEvent;
        const pos =
          view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos ?? view.state.selection.from;
        void uploadAndInsertAt(editor, files, pos);
        return true;
      },
      // Paste: same shape, files come from clipboardData. Insert at
      // the current cursor — pastes don't have spatial coords.
      handlePaste: (_view, ev, _slice): boolean => {
        const cd = (ev as ClipboardEvent).clipboardData;
        const files = cd ? imageFilesFrom(cd) : [];
        if (files.length === 0) return false;
        ev.preventDefault();
        void uploadAndInsertAt(editor, files, null);
        return true;
      }
    }
  });

  /** Pull image File entries out of a DataTransfer / Clipboard event.
   * Filters by type so a drop containing both an image and a text
   * snippet doesn't double-handle. */
  function imageFilesFrom(source: {
    files?: FileList | null;
    items?: DataTransferItemList;
  }): File[] {
    const out: File[] = [];
    // .files works for drag-drop. clipboardData.files is empty in some
    // browsers for image paste; .items is the fallback.
    if (source.files) {
      for (const f of Array.from(source.files)) {
        if (f.type.startsWith('image/')) out.push(f);
      }
    }
    if (out.length === 0 && source.items) {
      for (const item of Array.from(source.items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) out.push(f);
        }
      }
    }
    return out;
  }

  /** Upload + insert N image files. Sequential so a partial-batch
   * failure doesn't dribble half the ids into the editor before
   * throwing. `pos === null` means "at current cursor". */
  async function uploadAndInsertAt(ed: Editor, files: File[], pos: number | null): Promise<void> {
    let cursor = pos;
    for (let i = 0; i < files.length; i++) {
      const f = files[i] as File;
      setStatus(`uploading ${f.name || 'image'} (${i + 1}/${files.length})…`);
      try {
        const r = await uploadImage(f);
        const attrs: ImageAttrs = { id: r.id, alt: '', caption: '', position: 'default' };
        const chain = ed.chain().focus();
        if (cursor !== null) {
          chain.insertContentAt(cursor, { type: 'image', attrs });
          // Advance cursor for subsequent inserts so multiple images
          // land in source order, not stacked at the same point.
          cursor += 1;
        } else {
          chain.insertContent({ type: 'image', attrs });
        }
        chain.run();
        setStatus(
          `inserted ${f.name || 'image'} (${r.bytes} bytes${r.deduplicated ? ', dedup' : ''})`
        );
      } catch (err) {
        setStatus(`upload error: ${(err as Error).message}`);
        return;
      }
    }
  }

  // Drag-over visual cue. The browser fires dragenter / dragleave on
  // every descendant traversal, so we count enter/leave to know when
  // the user has actually left the drop zone vs just crossed an
  // internal boundary.
  const editorFrame = $('rkroll-admin-root');
  let dragDepth = 0;
  editorFrame.addEventListener('dragenter', (ev) => {
    if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types).includes('Files')) return;
    dragDepth++;
    editorFrame.classList.add('is-drag-over');
  });
  editorFrame.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) editorFrame.classList.remove('is-drag-over');
  });
  editorFrame.addEventListener('dragover', (ev) => {
    // Required: without preventDefault the browser refuses the drop
    // and falls back to navigating to the file (Chrome/Firefox both).
    if (ev.dataTransfer && Array.from(ev.dataTransfer.types).includes('Files')) {
      ev.preventDefault();
    }
  });
  editorFrame.addEventListener('drop', () => {
    dragDepth = 0;
    editorFrame.classList.remove('is-drag-over');
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
      // Reset transient UI; populated below from local edit state.
      attrResetBtn.hidden = true;
      attrResampleInput.value = '';
      attrUndoBtn.disabled = true;
      attrRedoBtn.disabled = true;
      attrSaveBtn.disabled = true;
      attrEditsList.replaceChildren();
      if (a.id) {
        const id = a.id;
        void ensureLocalState(id).then(
          (s) => {
            const resample = s.ops.find((o) => o.type === 'resample');
            if (resample && typeof resample.w === 'number') {
              attrResampleInput.value = String(resample.w);
            }
            renderEditsPanel(id, s);
            // Repaint preview from local ops — there might be unsaved
            // edits from a prior selection of this image in this session.
            void refreshImagePreview(editor, id, s.ops);
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

  /** Render one row per op (in click order), plus per-row delete buttons,
   * and update the undo/redo/save/reset button states. The id is captured
   * at render time so each delete button is bound to the image whose
   * panel was showing when the row was rendered — selectionUpdate will
   * rebuild the list if the selection changes. */
  function renderEditsPanel(id: string, s: LocalEditState): void {
    attrUndoBtn.disabled = s.ops.length === 0;
    attrRedoBtn.disabled = s.redoStack.length === 0;
    attrResetBtn.hidden = s.ops.length === 0;
    attrSaveBtn.disabled = !isDirty(s);
    const items = s.ops.map((op, idx) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.className = 'rkr-edits-step';
      span.textContent = `${idx + 1}. ${describeOp(op)}`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'rkr-edits-del';
      del.textContent = '×';
      del.title = 'Delete this step';
      del.setAttribute('aria-label', `Delete step ${idx + 1}: ${describeOp(op)}`);
      del.addEventListener('click', () => {
        localDeleteAt(s, idx);
        setStatus(`deleted step ${idx + 1}`);
        renderEditsPanel(id, s);
        void refreshImagePreview(editor, id, s.ops);
      });
      li.replaceChildren(span, del);
      return li;
    });
    attrEditsList.replaceChildren(...items);
  }

  /** Re-render the edits list + Save button state from local state, and
   * repaint the editor's <img> via the canvas pipeline. No server I/O —
   * the bake goes up only on Save (see attrSaveBtn handler). */
  function refreshAfterEdit(id: string, s: LocalEditState, label: string): void {
    setStatus(`${label} ${id.slice(0, 8)}…`);
    renderEditsPanel(id, s);
    void refreshImagePreview(editor, id, s.ops);
  }

  /** Mutate the active image's local state. Refuses if no image is
   * selected. Adding any op clears redoStack via localMutate. */
  function runEdit(label: string, mutator: (ops: SidecarOp[]) => SidecarOp[]): void {
    const id = activeImageId();
    if (!id) return;
    const s = localEditState.get(id);
    if (!s) return;
    localMutate(s, mutator);
    refreshAfterEdit(id, s, label);
  }

  attrCropBtn.addEventListener('click', () => {
    const id = activeImageId();
    if (!id) return;
    const s = localEditState.get(id);
    if (!s) return;
    void openCropper(id, s, () => {
      refreshAfterEdit(id, s, 'crop');
    });
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
  attrPerspBtn.addEventListener('click', () => {
    const id = activeImageId();
    if (!id) return;
    const s = localEditState.get(id);
    if (!s) return;
    void openPerspective(id, s, () => {
      refreshAfterEdit(id, s, 'perspective');
    });
  });
  attrUndoBtn.addEventListener('click', () => {
    const id = activeImageId();
    if (!id) return;
    const s = localEditState.get(id);
    if (!s) return;
    localUndo(s);
    refreshAfterEdit(id, s, 'undo');
  });
  attrRedoBtn.addEventListener('click', () => {
    const id = activeImageId();
    if (!id) return;
    const s = localEditState.get(id);
    if (!s) return;
    localRedo(s);
    refreshAfterEdit(id, s, 'redo');
  });
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
    const s = localEditState.get(id);
    if (!s) return;
    localMutate(s, () => []);
    attrResampleInput.value = '';
    refreshAfterEdit(id, s, 'edits reset');
  });
  attrSaveBtn.addEventListener('click', () => {
    const id = activeImageId();
    if (!id) return;
    const s = localEditState.get(id);
    if (!s || !isDirty(s)) return;
    // Guard against double-clicks during the (potentially multi-MB)
    // bake upload. Re-enabled by renderEditsPanel on success (where
    // isDirty is now false → disabled stays true) or explicitly on
    // failure so the user can retry.
    attrSaveBtn.disabled = true;
    setStatus(`saving edits ${id.slice(0, 8)}…`);
    void saveImageEdits(id, s).then(
      () => {
        renderEditsPanel(id, s);
        setStatus(`saved edits ${id.slice(0, 8)}…`);
      },
      (err: unknown) => {
        attrSaveBtn.disabled = false;
        setStatus(`save edits failed: ${(err as Error).message}`);
      }
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
  // Flush any dirty image edits BEFORE writing the post. Without this,
  // the saved markdown would reference image ids whose server-side ops
  // are stale relative to what the user just edited — silent data loss.
  // Uses the same code path the per-image Save button uses, so failures
  // leave the image state dirty and the user can retry.
  const dirtyCount = dirtyImageStates().length;
  if (dirtyCount > 0) {
    setStatus(`saving ${dirtyCount} image edit${dirtyCount === 1 ? '' : 's'}…`);
    const { ok, failed } = await flushDirtyImageEdits();
    if (failed > 0) {
      setStatus(`save aborted: ${failed}/${ok + failed} image edits failed to upload`);
      return;
    }
  }
  setStatus('saving…');
  try {
    const json = editor.getJSON() as ProseDoc;
    const markdown = proseToMarkdown(json);
    const result = await savePost({ slug, title, status, markdown });
    setStatus(`saved /${result.slug}`);
  } catch (err) {
    setStatus(`save error: ${(err as Error).message}`);
  }
}

// Warn on reload / close while any image has unsaved local edits.
// Modern browsers ignore the returned string and show a fixed prompt;
// preventDefault + a non-empty returnValue is the cross-browser idiom.
window.addEventListener('beforeunload', (ev) => {
  if (dirtyImageStates().length === 0) return;
  ev.preventDefault();
  ev.returnValue = '';
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
