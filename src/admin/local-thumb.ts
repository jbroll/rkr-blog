// Local-first thumbnail + original probing. Shared by image-insert
// (per-id hydration after a fresh upload) and the editor mount path
// (batch hydration of all figure thumbs whose uploads haven't drained
// yet) and canvas-loaders (OPFS fallback when /admin/original/<id>
// 404s).
//
// When uploadImage runs local-first, the bytes land in OPFS at
// originals/<id>.<ext> but the server's /admin/preview/<id> returns
// 404 until the background drain completes. Without these helpers,
// thumbs render broken (mount-time draft restore) and the image-edit
// canvas refuses to open (cropper/rotate require a decoded original).

import type { Editor } from '@tiptap/core';

import { readBlob } from './opfs.ts';

// Extensions probed when looking up originals/<id>.<ext>. The
// server-side extForMime returns 'jpeg', but pre-migration uploads
// may have used 'jpg'; keep both. The order is "most common first"
// to minimize round-trips on the happy path.
const PROBE_EXTS = ['webp', 'jpeg', 'jpg', 'png', 'gif', 'svg', 'heic', 'avif'] as const;

/** Probe OPFS for the local original of `id` and return its Blob,
 * or null if no local copy exists. Used by canvas-loaders' OPFS
 * fallback and by the hydration helpers below. */
export async function readLocalOriginal(id: string): Promise<Blob | null> {
  for (const ext of PROBE_EXTS) {
    const blob = await readBlob(`originals/${id}.${ext}`);
    if (blob) return blob;
  }
  return null;
}

/** Swap the `src` of every `img.rkr-image[data-id="<id>"]` in the
 * editor to a blob: URL backed by the OPFS original — or leave the
 * imgs alone if no local copy exists. Safe to call repeatedly. */
export async function hydrateLocalThumb(editor: Editor, id: string): Promise<void> {
  const blob = await readLocalOriginal(id);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const matches = editor.view.dom.querySelectorAll<HTMLImageElement>(
    `img.rkr-image[data-id="${id}"]`
  );
  for (const img of matches) img.src = url;
}

/** Walk the editor DOM, collect every unique data-id, and run
 * hydrateLocalThumb for each. Cheap when no local originals exist
 * (readLocalOriginal returns null for every probe). Call once after
 * the draft is restored so figures referencing not-yet-drained
 * uploads display their local bytes instead of broken thumbs. */
export async function hydrateAllLocalThumbs(editor: Editor): Promise<void> {
  const ids = new Set<string>();
  for (const img of editor.view.dom.querySelectorAll<HTMLImageElement>('img.rkr-image[data-id]')) {
    const id = img.dataset.id;
    if (id) ids.add(id);
  }
  await Promise.all([...ids].map((id) => hydrateLocalThumb(editor, id)));
}
