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

import { listDir, readJson, removeFile, writeJson } from './opfs.ts';
import { OPFS_DIRS } from './opfs-schema.ts';
import { list as outboxList } from './outbox.ts';

const DIR = OPFS_DIRS.PENDING_UPLOADS;

interface Marker {
  seq: number;
}

export async function markPendingUpload(id: string, seq: number): Promise<void> {
  await writeJson(`${DIR}/${id}.json`, { seq } satisfies Marker);
}

export async function clearPendingUpload(id: string): Promise<void> {
  /* v8 ignore next -- file may already be gone from cross-tab drain */
  await removeFile(`${DIR}/${id}.json`).catch(() => {});
}

/** True iff any of `ids` has a pending-upload marker. Returns
 * early on the first hit. */
export async function hasPendingMarker(ids: readonly string[]): Promise<boolean> {
  for (const id of ids) {
    const m = await readJson<Marker>(`${DIR}/${id}.json`);
    if (m) return true;
  }
  return false;
}

/** Reconcile markers against the live outbox. Markers whose seq
 * is no longer in the outbox (drained or coalesced away) are
 * dropped. Runs once at startup. */
export async function gcOrphanPendingMarkers(): Promise<void> {
  /* v8 ignore start -- startup-only path; covered by e2e */
  const entries = await listDir(DIR);
  if (entries.length === 0) return;
  const liveSeqs = new Set((await outboxList()).filter((e) => e.op === 'upload').map((e) => e.seq));
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const m = await readJson<Marker>(`${DIR}/${name}`);
    if (!m || !liveSeqs.has(m.seq)) {
      await removeFile(`${DIR}/${name}`).catch(() => {});
    }
  }
  /* v8 ignore stop */
}
