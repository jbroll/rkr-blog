// Reverse index for the save-waits-for-uploads guard. A marker file
// `pending-uploads/<id>.json` is written when an upload is queued
// and removed when it drains successfully. handleSave reads the
// editor state for referenced ids, then asks `hasPendingMarker`
// per id — O(1) per id, no regex over markdown, no scan of the
// outbox.
//
// Markers may outlive their outbox entries on the unhappy path
// (drain succeeded but the tab died before marker delete). GC
// runs at startup against the current outbox list.

import { readJson, removeFile, writeJson } from './opfs.ts';
import { OPFS_DIRS } from './opfs-schema.ts';

export const PENDING_UPLOADS_DIR = OPFS_DIRS.PENDING_UPLOADS;

interface Marker {
  seq: number;
}

export async function markPendingUpload(id: string, seq: number): Promise<void> {
  await writeJson(`${PENDING_UPLOADS_DIR}/${id}.json`, { seq } satisfies Marker);
}

export async function clearPendingUpload(id: string): Promise<void> {
  /* v8 ignore next -- file may already be gone from cross-tab drain */
  await removeFile(`${PENDING_UPLOADS_DIR}/${id}.json`).catch(() => {});
}

/** True iff any of `ids` has a pending-upload marker. Returns
 * early on the first hit. */
export async function hasPendingMarker(ids: readonly string[]): Promise<boolean> {
  for (const id of ids) {
    const m = await readJson<Marker>(`${PENDING_UPLOADS_DIR}/${id}.json`);
    if (m) return true;
  }
  return false;
}

/** Extract the outbox seq from a marker file. Used by the shared
 * `gcOrphansAgainstOutbox` (outbox.ts) at startup. */
export async function seqFromMarker(name: string): Promise<number | null> {
  /* v8 ignore start -- startup-only path; covered by e2e */
  if (!name.endsWith('.json')) return null;
  const m = await readJson<Marker>(`${PENDING_UPLOADS_DIR}/${name}`);
  return m?.seq ?? null;
  /* v8 ignore stop */
}
