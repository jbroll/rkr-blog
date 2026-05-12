// Client-side preview pipeline: download the master once, decode it,
// apply ops in-browser via canvas, swap the <img src> to a Blob URL.
// Avoids a server round-trip per click. Falls back to the server-baked
// preview when the browser can't decode the format (notably HEIC).

import type { Editor } from '@tiptap/core';

import type { SidecarOp } from '../lib/sidecar-types.ts';
import { PipelineCache } from './canvas';

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

export function getPipelineCache(id: string): PipelineCache {
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
export function loadOriginal(id: string): Promise<HTMLImageElement> {
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
export function hasWebglSupport(): boolean {
  if (webglSupportCached !== null) return webglSupportCached;
  try {
    const probe = document.createElement('canvas');
    webglSupportCached = probe.getContext('webgl') !== null;
  } catch {
    webglSupportCached = false;
  }
  return webglSupportCached;
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: string,
  quality?: number
): Promise<Blob> {
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
export async function refreshImagePreview(
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

/** Latest blob URL produced by refreshImagePreview for `id`, or
 * `null` if the pipeline hasn't run yet. The cell-edit dialog reads
 * this to render an in-dialog preview that mirrors what the editor
 * <img> shows — visual feedback for each crop / rotate / flip / etc.
 * The URL is owned by the LRU above; callers must NOT revokeObjectURL
 * on it. */
export function getPreviewUrl(id: string): string | null {
  return previewBlobUrls.get(id) ?? null;
}
