// Outbox drain loop + multi-tab leader election (spec-offline §5).
//
// Module graph: drainers.ts imports `Drainer` (type) and
// `SavePostConflictError` (value) from here. One-way arrow — no
// cycle. Enforced by the circular-import gauntlet check.

import { listSuperseded, list as outboxList, remove as outboxRemove } from './outbox.ts';

const LOCK_NAME = 'rkr-sync-leader';
const CHANNEL_NAME = 'rkr-sync';

/** Owned here (not in drainers.ts) so drainers can throw it without
 * a circular import — sync.ts already owns DrainStatus.
 * @public */
export class SavePostConflictError extends Error {
  constructor(
    public readonly info: {
      slug: string;
      seq: number;
      serverUpdatedAt: string;
      clientLastSyncedAt: string;
    }
  ) {
    super(`savePost conflict on /${info.slug}: server updated ${info.serverUpdatedAt}`);
    this.name = 'SavePostConflictError';
  }
}

/** @public */
export type DrainStatus =
  | { kind: 'idle' }
  | { kind: 'draining'; remaining: number }
  | { kind: 'halted'; reason: string; lastSeq?: number }
  | {
      kind: 'conflict';
      slug: string;
      seq: number;
      serverUpdatedAt: string;
      clientLastSyncedAt: string;
    };

interface SyncEvent {
  type: 'status';
  status: DrainStatus;
}

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;

let currentStatus: DrainStatus = { kind: 'idle' };
// BroadcastChannel doesn't deliver to its own posters; same-tab
// subscribers (the badge) need a separate fan-out.
const localStatusHandlers = new Set<(status: DrainStatus) => void>();

function publish(status: DrainStatus): void {
  currentStatus = status;
  for (const h of localStatusHandlers) h(status);
  /* v8 ignore next 3 -- BroadcastChannel-less env */
  if (channel) {
    channel.postMessage({ type: 'status', status } satisfies SyncEvent);
  }
}

/** @public */
export function getStatus(): DrainStatus {
  return currentStatus;
}

/** @public */
export function onStatus(handler: (status: DrainStatus) => void): () => void {
  localStatusHandlers.add(handler);
  const cleanupLocal = (): void => {
    localStatusHandlers.delete(handler);
  };
  /* v8 ignore next 3 -- BroadcastChannel-less env */
  if (!channel) {
    return cleanupLocal;
  }
  const listener = (ev: MessageEvent<SyncEvent>): void => {
    if (ev.data?.type === 'status') handler(ev.data.status);
  };
  channel.addEventListener('message', listener);
  return () => {
    cleanupLocal();
    channel.removeEventListener('message', listener);
  };
}

/** @public */
export type Drainer = (
  entry: import('../lib/outbox-types.ts').OutboxEntry,
  blob: Blob | null
) => Promise<void>;

const drainers = new Map<string, Drainer>();

/** @public */
export function registerDrainer(op: string, drainer: Drainer): void {
  drainers.set(op, drainer);
}

/** @public */
export async function discardConflictedSave(): Promise<void> {
  /* v8 ignore next 4 -- conflict-resolution UI lives in storage panel */
  if (currentStatus.kind !== 'conflict') return;
  await outboxRemove({ seq: currentStatus.seq, op: 'savePost' });
  publish({ kind: 'idle' });
  await tryDrain();
}

/** Re-POST without X-Rkr-Last-Synced-At so the server accepts the
 * conflicted save unconditionally (spec-offline §6).
 * @public */
export async function forceConflictedSave(): Promise<void> {
  /* v8 ignore start -- conflict-resolution UI lives in storage panel */
  if (currentStatus.kind !== 'conflict') return;
  const seq = currentStatus.seq;
  const entries = await outboxList();
  const entry = entries.find((e) => e.seq === seq);
  if (!entry || entry.op !== 'savePost') {
    await outboxRemove({ seq, op: 'savePost' });
    publish({ kind: 'idle' });
    await tryDrain();
    return;
  }
  const res = await fetch('/admin/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rkr-outbox-seq': String(seq) },
    body: JSON.stringify(entry.payload)
  });
  if (!res.ok) {
    publish({
      kind: 'halted',
      reason: `force overwrite failed: ${res.status}`,
      lastSeq: seq
    });
    return;
  }
  await outboxRemove({ seq, op: 'savePost' });
  publish({ kind: 'idle' });
  await tryDrain();
  /* v8 ignore stop */
}

/** Acquire the leader lock and run the drain. No-op when another
 * tab holds the lock — that tab is the leader. Caveat: a tab
 * frozen mid-drainLoop releases the Web Lock at the OS level even
 * though its JS may still be running; another tab can pick up the
 * drain in parallel for a few seconds. Safe — outboxRemove is
 * idempotent and the drainers themselves are safe to repeat. */
export function tryDrain(): Promise<void> {
  /* v8 ignore next 3 -- Web Locks is universal where OPFS is */
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return Promise.resolve();
  }
  return navigator.locks
    .request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      await drainLoop();
    })
    .then(() => {});
}

/* v8 ignore start -- requires queued entries; covered by the
   offline-flow e2e specs */
async function drainLoop(): Promise<void> {
  // coalescePending partitions seqs into kept/dropped (never both),
  // so the dropped set is safe to remove in parallel.
  const superseded = await listSuperseded();
  await Promise.all(superseded.map((stale) => outboxRemove(stale)));

  let remaining = (await outboxList()).length;
  publish({ kind: 'draining', remaining });

  while (remaining > 0) {
    const entries = await outboxList();
    if (entries.length === 0) break;
    const head = entries[0] as import('../lib/outbox-types.ts').OutboxEntry;
    const drainer = drainers.get(head.op);
    if (!drainer) {
      publish({ kind: 'halted', reason: `no drainer for op=${head.op}`, lastSeq: head.seq });
      return;
    }
    try {
      // bake entries carry the blob via outbox-blobs/<seq>.bin;
      // upload entries read from originals/ in their drainer.
      const blob = head.op === 'bake' ? await readEntryBlobOrThrow(head.seq) : null;
      await drainer(head, blob);
      await outboxRemove(head);
    } catch (err) {
      if (err instanceof SavePostConflictError) {
        publish({ kind: 'conflict', ...err.info });
        return;
      }
      publish({ kind: 'halted', reason: (err as Error).message, lastSeq: head.seq });
      return;
    }
    remaining = (await outboxList()).length;
    publish({ kind: 'draining', remaining });
  }

  publish({ kind: 'idle' });
  // After-drain-empty hook (spec-offline §7): eviction subscribes.
  for (const fn of afterEmptyHandlers) {
    try {
      await fn();
    } catch {
      /* swallow */
    }
  }
}

async function readEntryBlobOrThrow(seq: number): Promise<Blob> {
  const { readEntryBlob } = await import('./outbox.ts');
  const blob = await readEntryBlob(seq);
  if (!blob) throw new Error(`outbox entry ${seq} has no blob`);
  return blob;
}
/* v8 ignore stop */

const afterEmptyHandlers = new Set<() => Promise<void> | void>();

/** @public */
export function onAfterDrainEmpty(handler: () => Promise<void> | void): () => void {
  afterEmptyHandlers.add(handler);
  return () => afterEmptyHandlers.delete(handler);
}
