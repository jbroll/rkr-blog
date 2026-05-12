// Local-first thumbnail + original probing. Shared by image-insert
// (per-id hydration after a fresh upload), the editor mount path
// (batch hydration of figure thumbs whose uploads haven't drained
// yet), and canvas-loaders (OPFS fallback when /admin/original/<id>
// 404s).
//
// Hydration is GATED on the outbox: only ids with a pending upload
// entry get their thumb swapped to a blob: URL backed by OPFS. For
// drained ids, /admin/preview/<id> 302s to the post-ops derivative
// — hydrating those would clobber the server URL with the raw
// upload, hiding crops/rotates/etc on every reload. (Regression:
// before this gate, a saved crop appeared on the public site but
// the editor showed the uncropped raw after refresh.)

import type { Editor } from '@tiptap/core';

import { readBlob } from './opfs.ts';
import { list as outboxList } from './outbox.ts';

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

/** Collect ids that still have a pending `upload` outbox entry. These
 * are the ids the server can't resolve via /admin/preview/<id> yet,
 * so we hydrate from OPFS. Drained ids are excluded — for them, the
 * server's redirect honours the current sidecar ops. */
async function pendingUploadIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const entry of await outboxList()) {
    if (entry.op === 'upload') ids.add(entry.payload.id);
  }
  return ids;
}

/** Swap `<img.rkr-image[data-id="<id>"]>` srcs in the editor to a
 * blob: URL backed by the OPFS original.
 *
 * Two modes:
 * - `ids` passed: hydrate those specific ids UNCONDITIONALLY. Caller
 *   has just queued the upload (image-insert.ts), so the bytes
 *   exist in OPFS but the server's /admin/preview/<id> isn't ready
 *   yet — race-free signal that hydration is wanted.
 * - `ids` omitted: scan the editor's DOM (mount-time draft restore)
 *   and hydrate ONLY ids with a pending upload entry. Drained ids
 *   are left alone — /admin/preview/<id> serves the post-ops
 *   derivative, and swapping it to the no-ops OPFS raw would
 *   silently hide the saved crop/rotate/etc on every reload.
 *
 * Safe to call repeatedly; imgs with no local copy in OPFS are
 * left alone. */
export async function hydrateLocalThumbs(editor: Editor, ids?: readonly string[]): Promise<void> {
  let targets: string[];
  if (ids) {
    targets = [...new Set(ids)];
  } else {
    const pending = await pendingUploadIds();
    const seen = new Set<string>();
    for (const img of editor.view.dom.querySelectorAll<HTMLImageElement>(
      'img.rkr-image[data-id]'
    )) {
      const id = img.dataset.id;
      if (id && pending.has(id)) seen.add(id);
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
