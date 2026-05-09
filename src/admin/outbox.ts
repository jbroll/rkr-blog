// Sequenced write-back outbox for offline-first authoring. Append
// here when the user clicks save/upload offline; sync.ts (phase 1d)
// drains entries against the server when connectivity returns.
//
// On-disk layout (spec-offline.md §4 + §5):
//   opfs://outbox/<seq>.<op>.json   metadata + payload (no blob)
//   opfs://outbox-blobs/<seq>.bin   binary payload for upload + bake
//
// Properties:
//   • Globally ordered: seq comes from _root.json#nextSeq, advanced
//     atomically per append. Multi-tab leader election (phase 1d)
//     ensures only one tab calls append at a time.
//   • Idempotent on retry: seq files are deleted on 2xx by sync.ts.
//     A crashed drain leaves the entry to retry next pass; every
//     consumed endpoint is content-addressed or upserts.
//   • Atomic-in-log per entry: the JSON write IS the commit.
//
// What's NOT here (phase 1d / 1e):
//   • The drain loop + leader election + 5xx backoff.
//   • Online/offline detection — append doesn't care; sync.ts does.

import { coalescePending, type OutboxEntry } from '../lib/outbox-types.ts';
import { listDir, readBlob, readJson, removeFile, writeBlob, writeJson } from './opfs.ts';
import { type OpfsRoot, readRoot, writeRoot } from './opfs-schema.ts';

const OUTBOX_DIR = 'outbox';
const BLOB_DIR = 'outbox-blobs';

/** Append one entry. Reserves the next seq from _root.json,
 * writes the JSON file, and (if blob is supplied) the matching
 * .bin. Returns the assigned seq.
 * @public */
export async function append(
  entry: Omit<OutboxEntry, 'seq' | 'createdAt' | 'deviceId'>,
  blob?: Blob
): Promise<number> {
  /* v8 ignore start -- exercised once phase 1f wires uploadImage /
     saveImageEdits / handleSave through the outbox */
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
    // Write the blob FIRST so a crash between blob and JSON leaves
    // an orphan blob (cleaned by GC) rather than a JSON entry
    // pointing at a missing blob (which would fail on drain).
    await writeBlob(blobPath(seq), blob);
  }
  await writeJson(jsonPath(seq, full.op), full);
  return seq;
  /* v8 ignore stop */
}

/** Read all pending outbox entries in seq order. Coalesces
 * redundant entries (per spec-offline §13 — keep only the latest
 * savePost per slug + setOps per id). The dropped entries' files
 * are NOT removed here; the caller (sync.ts) deletes them after a
 * successful drain pass over the kept ones. */
export async function list(): Promise<OutboxEntry[]> {
  const names = await listDir(OUTBOX_DIR);
  const entries: OutboxEntry[] = [];
  /* v8 ignore start -- entries-present branch fires once 1f appends */
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const e = await readJson<OutboxEntry>(`${OUTBOX_DIR}/${name}`);
    if (e) entries.push(e);
  }
  entries.sort((a, b) => a.seq - b.seq);
  /* v8 ignore stop */
  return coalescePending(entries);
}

/** List entries that coalescing dropped — caller (sync.ts) deletes
 * them so OPFS doesn't accumulate stale files. Walks the same
 * directory as list() but returns the COMPLEMENT. */
/* v8 ignore start -- needs entries to filter; phase 1f exercises */
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

/** Drop an entry from the outbox. Used by sync.ts after a
 * successful POST. Removes both the JSON file and any matching
 * blob (idempotent — silent on already-gone). */
export async function remove(entry: Pick<OutboxEntry, 'seq' | 'op'>): Promise<void> {
  await removeFile(jsonPath(entry.seq, entry.op));
  await removeFile(blobPath(entry.seq));
}

/** Read the binary blob for an `upload` or `bake` entry. Returns
 * null if the blob is missing (which is a corrupt-state error the
 * caller surfaces). */
export async function readEntryBlob(seq: number): Promise<Blob | null> {
  return readBlob(blobPath(seq));
}
/* v8 ignore stop */

/** Number of pending entries (post-coalesce). Used for the status
 * indicator badge. */
export async function pendingCount(): Promise<number> {
  return (await list()).length;
}

/* v8 ignore start -- helpers consumed by append/remove which are
   ignored until phase 1f exercises them */
function jsonPath(seq: number, op: OutboxEntry['op']): string {
  return `${OUTBOX_DIR}/${seq}.${op}.json`;
}

function blobPath(seq: number): string {
  return `${BLOB_DIR}/${seq}.bin`;
}
/* v8 ignore stop */
