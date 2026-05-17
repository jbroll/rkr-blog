// Outbox drain loop + multi-tab leader election (spec-offline §5).
//
// Module graph: drainers.ts imports `Drainer` (type) and
// `SavePostConflictError` (value) from here. One-way arrow — no
// cycle. Enforced by the circular-import gauntlet check.

import { runEviction } from './eviction.ts';
import { getState as getOnlineState } from './online-state.ts';
import {
  listSuperseded,
  list as outboxList,
  remove as outboxRemove,
  readEntryBlob
} from './outbox.ts';

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

/** Cross-tab cache-invalidation broadcast. Sent after a
 * commitImageEdit drain succeeds so other tabs can drop their
 * in-memory `localEditState` for the id and the stale
 * `image-state/<id>.json` in OPFS — preventing tab B from
 * clobbering tab A's just-committed ops on a later save. */
interface InvalidateImageStateEvent {
  type: 'invalidate-image-state';
  id: string;
}

type ChannelMessage = SyncEvent | InvalidateImageStateEvent;

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

// Local fan-out for image-state invalidations — BroadcastChannel
// doesn't deliver to its own posters, so same-tab subscribers
// (the editor's in-memory localEditState) need a separate fan-out.
// We do NOT call same-tab handlers from publishImageStateInvalidation
// because the same tab that drained the commit just adopted the
// normalised ops as its baseline — invalidating its own cache would
// throw that work away. Cross-tab delivery only.
const localImageStateHandlers = new Set<(id: string) => void>();

/** @public */
export function onImageStateInvalidated(handler: (id: string) => void): () => void {
  localImageStateHandlers.add(handler);
  const cleanupLocal = (): void => {
    localImageStateHandlers.delete(handler);
  };
  /* v8 ignore next 3 -- BroadcastChannel-less env */
  if (!channel) return cleanupLocal;
  const listener = (ev: MessageEvent<ChannelMessage>): void => {
    if (ev.data?.type === 'invalidate-image-state') handler(ev.data.id);
  };
  channel.addEventListener('message', listener);
  return () => {
    cleanupLocal();
    channel.removeEventListener('message', listener);
  };
}

/** Broadcast that an image's persisted state has moved on (tab A
 * drained a commit; tab B's cached state is now stale). Local
 * subscribers are NOT invoked — the publisher already adopted the
 * normalised ops as baseline. Cross-tab listeners drop their cache.
 * @public */
export function publishImageStateInvalidation(id: string): void {
  /* v8 ignore next 3 -- BroadcastChannel-less env */
  if (channel) {
    channel.postMessage({
      type: 'invalidate-image-state',
      id
    } satisfies InvalidateImageStateEvent);
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
    headers: {
      'content-type': 'application/json',
      // Idempotency key (Task 8). NOTE: the force path deliberately
      // omits x-rkr-last-synced-at so the server accepts the
      // overwrite unconditionally; keying it the same as the normal
      // drain means a lost-ACK replay of THIS request still
      // short-circuits to the stored 2xx.
      'x-rkr-outbox-seq': String(seq),
      'x-rkr-device-id': entry.deviceId
    },
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

/** Wait for the drain queue to settle (idle / halted / conflict).
 * Unlike tryDrain — which is fire-and-forget and skips if the leader
 * is busy — this serializes on the leader lock so the caller's
 * Promise doesn't resolve until the in-flight drain (if any) AND a
 * fresh drain pass have completed. handleSave uses this to defer the
 * direct POST until prerequisite uploads have drained. */
export function awaitDrainSettled(): Promise<DrainStatus> {
  /* v8 ignore next 3 -- Web Locks is universal where OPFS is */
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return Promise.resolve(currentStatus);
  }
  return navigator.locks.request(LOCK_NAME, async () => {
    await drainLoop();
    return currentStatus;
  });
}

/* v8 ignore start -- requires queued entries; covered by the
   offline-flow e2e specs */

// Per-entry retry budget for transient drainer failures (5xx,
// network blips). Resets per session — a tab reload is treated as
// a fresh start. Conflict errors (savePost mtime mismatch) and
// no-drainer-registered are NOT retried.
const MAX_DRAIN_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const;

/** Sleep for `ms`. Hoisted so the retry loop reads cleanly and
 * tests can stub setTimeout via fake timers if needed. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    // bake entries carry the blob via outbox-blobs/<seq>.bin;
    // upload entries read from originals/ in their drainer.
    // commitImageEdit entries with hasBake=true carry the WebP via
    // outbox-blobs/<seq>.bin; upload entries read from originals/.
    const needsBlob = head.op === 'commitImageEdit' && head.payload.hasBake;
    const blob = needsBlob ? await readEntryBlobOrThrow(head.seq) : null;
    const status = await drainEntryWithRetry(head, blob, drainer);
    if (status.kind === 'conflict') {
      publish({ kind: 'conflict', ...status.info });
      return;
    }
    if (status.kind === 'failed') {
      publish({ kind: 'halted', reason: status.reason, lastSeq: head.seq });
      return;
    }
    await outboxRemove(head);
    // Tell other tabs to drop their cached state for this image so
    // their next save doesn't clobber the just-committed ops.
    if (head.op === 'commitImageEdit') {
      publishImageStateInvalidation(head.payload.id);
    }
    remaining = (await outboxList()).length;
    publish({ kind: 'draining', remaining });
  }

  publish({ kind: 'idle' });
  // Eviction runs after each drain-to-empty (spec-offline §7). Direct
  // call instead of pub/sub — the dependency is real and the
  // indirection hid it. Errors here swallow on purpose: a transient
  // OPFS failure (quota glitch, IO race) shouldn't surface from the
  // drain loop; the NEXT drain-to-empty re-runs eviction, and the
  // standalone startup-time eviction call gives us a second chance
  // on the next page load. Worst case: a brief over-quota state
  // until either path retries.
  try {
    await runEviction();
  } catch {
    /* swallow */
  }
}

type DrainEntryResult =
  | { kind: 'ok' }
  | { kind: 'conflict'; info: SavePostConflictError['info'] }
  | { kind: 'failed'; reason: string };

/** Retry a drainer with exponential backoff. SavePostConflictError
 * bubbles up immediately (user must resolve via discard/force).
 * Other errors retry up to MAX_DRAIN_ATTEMPTS; on exhaustion the
 * caller halts the loop. Retries are SKIPPED when the browser is
 * offline — the online-state listener triggers a fresh `tryDrain`
 * on reconnect, so burning the budget mid-disconnect would just
 * hold the leader lock for 31s and starve a manual "Sync now". */
async function drainEntryWithRetry(
  entry: import('../lib/outbox-types.ts').OutboxEntry,
  blob: Blob | null,
  drainer: Drainer
): Promise<DrainEntryResult> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MAX_DRAIN_ATTEMPTS; attempt++) {
    try {
      await drainer(entry, blob);
      return { kind: 'ok' };
    } catch (err) {
      if (err instanceof SavePostConflictError) {
        return { kind: 'conflict', info: err.info };
      }
      lastErr = err as Error;
      // Offline-aware halt: no point spinning through 5×backoff
      // when the radio is off. The online-state listener fires a
      // fresh tryDrain on reconnect.
      if (getOnlineState() === 'offline') break;
      if (attempt < MAX_DRAIN_ATTEMPTS - 1) {
        await delay(RETRY_DELAYS_MS[attempt] ?? 30000);
      }
    }
  }
  return { kind: 'failed', reason: lastErr?.message ?? 'unknown drain failure' };
}

async function readEntryBlobOrThrow(seq: number): Promise<Blob> {
  // Static import (was dynamic before commit ec94f24+). Dynamic
  // `import('./outbox.ts')` produced a separate chunk that could
  // fail to fetch when the editor was offline mid-drain, freezing
  // the queue even after reconnect because the ES module loader
  // caches the rejected import. Inlining keeps the helper available
  // at all times.
  const blob = await readEntryBlob(seq);
  if (!blob) throw new Error(`outbox entry ${seq} has no blob`);
  return blob;
}
/* v8 ignore stop */
