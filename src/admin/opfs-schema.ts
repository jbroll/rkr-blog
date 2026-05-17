// OPFS schema versioning + migration framework (spec-offline §10).

import { isSupported, listDir, readJson, writeJson } from './opfs.ts';

/** Bump alongside any schema-affecting change. Pure additions of
 * optional fields don't need a bump — see spec-offline §10 for the
 * migration playbook. */
const OPFS_SCHEMA_CURRENT = 1 as const;

const ROOT_PATH = 'meta/_root.json';

/** Canonical OPFS layout. Owned by this module so a future schema
 * migration that renames a directory has one place to change. */
export const OPFS_DIRS = {
  DRAFTS: 'drafts',
  META: 'meta',
  ORIGINALS: 'originals',
  SIDECARS: 'sidecars',
  IMAGE_STATE: 'image-state',
  BAKES: 'bakes',
  OUTBOX: 'outbox',
  OUTBOX_BLOBS: 'outbox-blobs',
  /** Reverse index for save-waits-for-uploads: a per-id marker file
   * landed at queueUpload time, removed at drainUpload success. Lets
   * the save guard ask `exists(<id>)?` in O(1) instead of scanning
   * the whole outbox JSON list. */
  PENDING_UPLOADS: 'pending-uploads'
} as const;

/** @public */
export interface OpfsRoot {
  schemaVersion: number;
  deviceId: string;
  /** Monotonic outbox-seq counter. Defaults to 0 when missing. */
  nextSeq?: number;
  /** Active draft id (single-draft session model). */
  currentDraftId?: string;
}

export type SchemaStatus =
  | { status: 'unsupported' }
  | { status: 'fresh' }
  | { status: 'current' }
  | { status: 'migrated'; from: number; to: number }
  | { status: 'downgrade'; onDisk: number; current: number };

type Migration = (root: OpfsRoot) => Promise<OpfsRoot>;

/** Forward migrations keyed "from->to". Bump OPFS_SCHEMA_CURRENT in
 * the same commit that adds an entry. */
const MIGRATIONS: Map<string, Migration> = new Map();

function makeRoot(): OpfsRoot {
  return {
    schemaVersion: OPFS_SCHEMA_CURRENT,
    deviceId: makeDeviceId(),
    nextSeq: 0
  };
}

export async function readRoot(): Promise<OpfsRoot | null> {
  return readJson<OpfsRoot>(ROOT_PATH);
}

export async function writeRoot(root: OpfsRoot): Promise<void> {
  await writeJson(ROOT_PATH, root);
}

/** The single Web Lock serialising every read-modify-write of
 * _root.json. Owned here so the outbox append path AND the
 * currentDraftId writers share ONE lock and can never interleave a
 * stale nextSeq over a concurrent bump. Value MUST stay equal to the
 * name outbox.append()/gcUnderAppendLock acquire. */
export const ROOT_LOCK = 'rkr-outbox-append';

export function withRootLock<T>(fn: () => Promise<T>): Promise<T> {
  return navigator.locks.request(ROOT_LOCK, fn) as Promise<T>;
}

/** Atomic read-modify-write of _root.json under ROOT_LOCK. `fn` gets
 * the current root (or a fresh one if absent) and returns the next
 * root to persist. Every currentDraftId/nextSeq mutation MUST go
 * through this so concurrent tabs can't clobber each other. */
export async function mutateRoot(
  fn: (root: OpfsRoot) => OpfsRoot | Promise<OpfsRoot>
): Promise<OpfsRoot> {
  return withRootLock(async () => {
    const current = (await readRoot()) ?? makeRoot();
    const next = await fn(current);
    await writeRoot(next);
    return next;
  });
}

function makeDeviceId(): string {
  return crypto.randomUUID();
}

/** Scan the outbox directory and return the highest seq number found
 * in filenames (format: `<seq>.<op>.json`). Returns 0 when the
 * outbox is absent or empty. Used to seed nextSeq above any live
 * entries when _root.json is missing or corrupt, preventing seq
 * collisions that would break coalescing/ordering of un-drained work. */
async function maxOutboxSeqOnDisk(): Promise<number> {
  const names = await listDir(OPFS_DIRS.OUTBOX);
  let max = 0;
  for (const n of names) {
    const seq = Number.parseInt(n.split('.')[0] ?? '', 10);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max;
}

export async function ensureSchema(): Promise<SchemaStatus> {
  /* v8 ignore next 3 -- pre-OPFS browser */
  if (!isSupported()) {
    return { status: 'unsupported' };
  }
  const onDisk = await readJson<OpfsRoot>(ROOT_PATH);
  if (!onDisk) {
    // Under ROOT_LOCK so the fresh/floor-seeded write can't interleave
    // with a concurrent append()'s nextSeq bump. The floor read and the
    // write happen atomically inside the locked callback. mutateRoot's
    // callback receives a fresh makeRoot() here (readRoot() is still
    // null) — equivalent to the old makeRoot(), now lock-serialised.
    await mutateRoot(async (root) => {
      // A corrupt/quarantined or missing _root.json must not reset
      // nextSeq beneath live outbox entries — that collides seqs and
      // breaks coalescing/ordering, orphaning un-drained work. Seed
      // above the highest on-disk seq.
      const floor = await maxOutboxSeqOnDisk();
      if (floor > 0) return { ...root, nextSeq: floor + 1 };
      return root;
    });
    return { status: 'fresh' };
  }

  const fromVersion = onDisk.schemaVersion;
  if (fromVersion === OPFS_SCHEMA_CURRENT) {
    return { status: 'current' };
  }
  /* v8 ignore start -- v1-unreachable: no v2 schema yet */
  if (fromVersion > OPFS_SCHEMA_CURRENT) {
    return { status: 'downgrade', onDisk: fromVersion, current: OPFS_SCHEMA_CURRENT };
  }

  let working = onDisk;
  for (let v = fromVersion; v < OPFS_SCHEMA_CURRENT; v++) {
    const key = `${v}->${v + 1}`;
    const step = MIGRATIONS.get(key);
    if (!step) {
      throw new Error(`opfs-schema: missing migration ${key}`);
    }
    working = await step(working);
    working.schemaVersion = v + 1;
  }
  // Under ROOT_LOCK so the migrated _root.json write can't interleave
  // with a concurrent append()'s nextSeq bump. WHAT is written is
  // unchanged — only the lock is added.
  await withRootLock(async () => {
    await writeJson(ROOT_PATH, working);
  });
  return { status: 'migrated', from: fromVersion, to: OPFS_SCHEMA_CURRENT };
  /* v8 ignore stop */
}
