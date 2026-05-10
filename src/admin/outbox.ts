// Sequenced write-back outbox (spec-offline §4 + §5).
//
// On-disk layout:
//   opfs://outbox/<seq>.<op>.json   metadata + payload
//   opfs://outbox-blobs/<seq>.bin   binary payload for upload + bake
//
// Atomic-in-log: the JSON write IS the commit. The seq counter
// (_root.json#nextSeq) is read-modify-write, so append() must
// serialize against itself across same-tab parallel callers AND
// across tabs — the rkr-outbox-append Web Lock handles both.

import { coalescePending, type OutboxEntry } from '../lib/outbox-types.ts';
import { listDir, readBlob, readJson, removeFile, writeBlob, writeJson } from './opfs.ts';
import { type OpfsRoot, readRoot, writeRoot } from './opfs-schema.ts';

const OUTBOX_DIR = 'outbox';
const BLOB_DIR = 'outbox-blobs';
const APPEND_LOCK = 'rkr-outbox-append';

/** @public */
export async function append(
  entry: Omit<OutboxEntry, 'seq' | 'createdAt' | 'deviceId'>,
  blob?: Blob
): Promise<number> {
  /* v8 ignore start -- exercised by phase 1f offline-flow specs */
  // Web Lock around the read-modify-write of nextSeq + the per-
  // entry writes. Without it, parallel appends (e.g. handleSave
  // queueing savePost while flushDirtyImageEdits queues setOps)
  // can both observe the same nextSeq and produce colliding
  // entries — outbox/<seq>.<op>.json names differ but the seq
  // ordering breaks and remove() targets the wrong file.
  return navigator.locks.request(APPEND_LOCK, async () => {
    const root = await readRoot();
    if (!root) {
      throw new Error('outbox.append: _root.json missing — ensureSchema not called?');
    }
    const seq = (root.nextSeq ?? 0) + 1;
    const next: OpfsRoot = { ...root, nextSeq: seq };
    await writeRoot(next);

    const full: OutboxEntry = {
      ...(entry as OutboxEntry),
      seq,
      createdAt: new Date().toISOString(),
      deviceId: root.deviceId
    };

    if (blob) {
      // Blob first: a crash between blob and JSON leaves an orphan
      // blob (GC reclaims) rather than a JSON entry pointing at a
      // missing blob (which would fail on drain).
      await writeBlob(blobPath(seq), blob);
    }
    await writeJson(jsonPath(seq, full.op), full);
    return seq;
  });
  /* v8 ignore stop */
}

/** Pending entries in seq order, post-coalesce (spec-offline §13:
 * keep only the latest savePost per slug + setOps per id). Caller
 * (sync.ts) deletes the dropped entries via listSuperseded. */
export async function list(): Promise<OutboxEntry[]> {
  const names = await listDir(OUTBOX_DIR);
  const entries: OutboxEntry[] = [];
  /* v8 ignore start -- entries-present branch */
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const e = await readJson<OutboxEntry>(`${OUTBOX_DIR}/${name}`);
    if (e) entries.push(e);
  }
  entries.sort((a, b) => a.seq - b.seq);
  /* v8 ignore stop */
  return coalescePending(entries);
}

/* v8 ignore start -- exercised by phase 1f offline-flow specs */
export async function listSuperseded(): Promise<OutboxEntry[]> {
  const names = await listDir(OUTBOX_DIR);
  const all: OutboxEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const e = await readJson<OutboxEntry>(`${OUTBOX_DIR}/${name}`);
    if (e) all.push(e);
  }
  const kept = new Set(coalescePending(all).map((e) => e.seq));
  return all.filter((e) => !kept.has(e.seq));
}

export async function remove(entry: Pick<OutboxEntry, 'seq' | 'op'>): Promise<void> {
  await removeFile(jsonPath(entry.seq, entry.op));
  await removeFile(blobPath(entry.seq));
}

export async function readEntryBlob(seq: number): Promise<Blob | null> {
  return readBlob(blobPath(seq));
}
/* v8 ignore stop */

export async function pendingCount(): Promise<number> {
  return (await list()).length;
}

/* v8 ignore start -- consumed by append/remove */
function jsonPath(seq: number, op: OutboxEntry['op']): string {
  return `${OUTBOX_DIR}/${seq}.${op}.json`;
}

function blobPath(seq: number): string {
  return `${BLOB_DIR}/${seq}.bin`;
}
/* v8 ignore stop */
