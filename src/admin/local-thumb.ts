// Local-first original probing: the OPFS copy of an upload, used by
// canvas-loaders (fallback when /admin/original/<id> 404s) and the
// unified editor's local thumbnails while an upload is still queued.

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
