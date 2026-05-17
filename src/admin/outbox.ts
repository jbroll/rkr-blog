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
import { OPFS_DIRS, type OpfsRoot, readRoot, writeRoot } from './opfs-schema.ts';

const OUTBOX_DIR = OPFS_DIRS.OUTBOX;
const BLOB_DIR = OPFS_DIRS.OUTBOX_BLOBS;
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

/** Live outbox seqs (filename-parsed; no JSON I/O). */
async function listLiveSeqs(): Promise<Set<number>> {
  const names = await listDir(OUTBOX_DIR).catch(() => [] as string[]);
  const seqs = new Set<number>();
  for (const name of names) {
    const m = /^(\d+)\./.exec(name);
    if (m) seqs.add(Number(m[1]));
  }
  return seqs;
}

/** GC orphan files in `dir` against the live outbox. Each file's
 * seq is derived by `seqFromName` (sync regex for filename-encoded
 * seq, or async readJson for inline-encoded seq). Files whose seq
 * is not in the live set are removed.
 *
 * Two orphan classes are reconciled this way:
 *  - `outbox-blobs/<seq>.bin` — written before the JSON commits
 *    (intentional ordering; crash between blob+JSON leaves an
 *    orphan blob rather than a drain-halting dangling JSON).
 *  - `pending-uploads/<id>.json` — written at outboxAppend time,
 *    removed at drainUpload success. A tab killed between drain
 *    success and the marker-delete leaves an orphan.
 *
 * Best-effort; failures don't block startup.
 * @public */
export async function gcOrphansAgainstOutbox(
  dir: string,
  seqFromName: (name: string) => Promise<number | null> | number | null
): Promise<number> {
  const live = await listLiveSeqs();
  const names = await listDir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    const seq = await seqFromName(name);
    if (seq !== null && live.has(seq)) continue;
    await removeFile(`${dir}/${name}`).catch(() => {});
    removed++;
  }
  return removed;
}

/** Sweep leaked atomic-write temp files. opfs.ts atomicWrite() stages
 * into a sibling `.${leaf}.tmp-${uuid}` then move()s it onto the
 * target; the in-line catch only covers a fault DURING staging. A tab
 * killed after close() but before/within move(), or a throwing
 * move() itself, leaks the fully-written temp forever — unbounded on
 * the highest-frequency path (writeJson(_root.json) on every schema
 * mutation). This is the missing sweeper.
 *
 * A `.tmp-` name is NEVER a live file: the live name is always the
 * move() target (the leaf), never the temp. So any `.tmp-` straggler
 * is provably dead and unconditionally removable. Runs at boot before
 * this tab issues writes; a cross-tab sub-ms temp colliding with the
 * sweep is negligible and fails loud (the other tab's move() errors,
 * it does not corrupt the target). Best-effort; failures don't block
 * startup. @public */
export async function gcAtomicWriteTemps(): Promise<number> {
  let removed = 0;
  for (const dir of Object.values(OPFS_DIRS)) {
    const names = await listDir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!/\.tmp-/.test(name)) continue;
      await removeFile(`${dir}/${name}`).catch(() => {});
      removed++;
    }
  }
  return removed;
}

/** One-shot migration: drop outbox entries with a legacy op kind
 * ('setOps' or 'bake') that no longer has a registered drainer after
 * the /commit endpoint replaced the /ops + /bake split. Without this,
 * an upgraded client with pending pre-migration entries halts on
 * "no drainer for op=setOps" forever.
 *
 * Filename convention is `<seq>.<op>.json`, so we can identify legacy
 * entries by name without parsing JSON. Best-effort; failures don't
 * block startup. Runs once on every page load and is a no-op when no
 * legacy entries exist, which is the common case.
 * @public */
export async function dropLegacyOpEntries(): Promise<number> {
  const LEGACY = new Set(['setOps', 'bake']);
  let dropped = 0;
  const names = await listDir(OUTBOX_DIR).catch(() => [] as string[]);
  for (const name of names) {
    const m = /^(\d+)\.([^.]+)\.json$/.exec(name);
    if (!m) continue;
    const op = m[2] as string;
    if (!LEGACY.has(op)) continue;
    const seq = Number(m[1]);
    await removeFile(`${OUTBOX_DIR}/${name}`);
    await removeFile(blobPath(seq));
    dropped++;
  }
  return dropped;
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
