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

/** Swap `<img.rkr-image[data-id="<id>"]>` srcs in the editor to a
 * blob: URL backed by the OPFS original. When `ids` is omitted, scan
 * the editor's DOM and hydrate every figure thumb — used at mount
 * after draft-restore so figures referencing not-yet-drained uploads
 * display local bytes instead of broken thumbs. When `ids` is
 * passed, target just those ids — used right after a fresh insert.
 * Safe to call repeatedly; imgs with no local copy in OPFS are
 * left alone. */
export async function hydrateLocalThumbs(editor: Editor, ids?: readonly string[]): Promise<void> {
  let targets: string[];
  if (ids) {
    targets = [...new Set(ids)];
  } else {
    const seen = new Set<string>();
    for (const img of editor.view.dom.querySelectorAll<HTMLImageElement>(
      'img.rkr-image[data-id]'
    )) {
      const id = img.dataset.id;
      if (id) seen.add(id);
    }
    targets = [...seen];
  }
  await Promise.all(
    targets.map(async (id) => {
      const blob = await readLocalOriginal(id);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const matches = editor.view.dom.querySelectorAll<HTMLImageElement>(
        `img.rkr-image[data-id="${id}"]`
      );
      for (const img of matches) img.src = url;
    })
  );
}
