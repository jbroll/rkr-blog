// Outbox drain loop + multi-tab leader election.
//
// Multi-tab coordination (spec-offline.md §5.1): exactly one tab is
// the "leader" at a time, elected via the Web Locks API. The leader
// holds the rkr-sync-leader lock and runs the drain loop. Non-
// leader tabs subscribe to the BroadcastChannel('rkr-sync') so
// their UIs stay in sync without each tab making its own HTTP
// requests.
//
// Drain failure handling (spec-offline.md §5.2):
//   2xx          delete the entry, advance
//   409          halt; surface conflict to the user
//   4xx (other)  halt; surface "rejected: <message>"
//   5xx / netw   retry with backoff (0.5s/2s/8s ±20% jitter)
//                — same schedule as src/site/img-retry.ts
//   401          halt; surface "log in to sync"; outbox preserved
//
// What's NOT here (phases 1f / 1j):
//   • The HTTP-shape per op type (multipart vs JSON, headers).
//     Phase 1f: each op-flow registers its drainer.
//   • Status badge UI. Phase 1j: subscribes to the BroadcastChannel
//     and renders pending/conflict/online state.

import { listSuperseded, list as outboxList, remove as outboxRemove } from './outbox.ts';

const LOCK_NAME = 'rkr-sync-leader';
const CHANNEL_NAME = 'rkr-sync';

/** @public */
export type DrainStatus =
  | { kind: 'idle' }
  | { kind: 'draining'; remaining: number }
  | { kind: 'halted'; reason: string; lastSeq?: number };

interface SyncEvent {
  type: 'status';
  status: DrainStatus;
}

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;

let currentStatus: DrainStatus = { kind: 'idle' };

function publish(status: DrainStatus): void {
  currentStatus = status;
  /* v8 ignore next 3 -- environments without BroadcastChannel skip publish */
  if (channel) {
    channel.postMessage({ type: 'status', status } satisfies SyncEvent);
  }
}

/** Get the current status (last broadcast). UI subscribers can
 * call this on mount to render initial state without waiting for
 * the next event.
 * @public */
export function getStatus(): DrainStatus {
  return currentStatus;
}

/** Subscribe to status updates. Returns an unsubscribe function.
 * @public */
export function onStatus(handler: (status: DrainStatus) => void): () => void {
  /* v8 ignore next 3 -- BroadcastChannel-less envs return no-op unsub */
  if (!channel) {
    return () => {};
  }
  const listener = (ev: MessageEvent<SyncEvent>): void => {
    if (ev.data?.type === 'status') handler(ev.data.status);
  };
  channel.addEventListener('message', listener);
  return () => channel.removeEventListener('message', listener);
}

/** Per-op drain handler. Phase 1f registers one of these for each
 * op type (upload, setOps, bake, savePost). Returns void on success
 * (the entry is removed); throws on failure (signals halt).
 * @public */
export type Drainer = (
  entry: import('../lib/outbox-types.ts').OutboxEntry,
  blob: Blob | null
) => Promise<void>;

const drainers = new Map<string, Drainer>();

/** Wire up the drain handler for a given op. Phase 1f calls this
 * once per op type at mount.
 * @public */
export function registerDrainer(op: string, drainer: Drainer): void {
  drainers.set(op, drainer);
}

/** Try to acquire the leader lock and run the drain loop. If the
 * lock is held by another tab, returns immediately — that tab is
 * the leader. The leader's drain loop runs until the outbox is
 * empty, halts on first failure, or the lock is released (tab
 * close). Safe to call repeatedly: re-acquiring while you ARE the
 * leader is a no-op via the Web Locks API.
 *
 * Phase 1f calls this on every `online` event AND on every
 * outbox.append() so a fresh edit drains as soon as possible. */
export function tryDrain(): Promise<void> {
  /* v8 ignore next 3 -- Web Locks is universal in OPFS-supporting browsers */
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return Promise.resolve();
  }
  return navigator.locks
    .request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      // ifAvailable returns null when the lock is busy — another
      // tab is the leader. We're done; no drain.
      if (!lock) return;
      await drainLoop();
    })
    .then(() => {});
}

/* v8 ignore start -- the body fires only when phase 1f starts
   appending entries; until then the loop runs once over empty
   outbox state and exits via the early return below */
async function drainLoop(): Promise<void> {
  // Drop superseded entries first so the kept set is the real
  // queue and the count we publish is accurate.
  for (const stale of await listSuperseded()) {
    await outboxRemove(stale);
  }

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
      const blob =
        head.op === 'upload' || head.op === 'bake' ? await readEntryBlobOrThrow(head.seq) : null;
      await drainer(head, blob);
      await outboxRemove(head);
    } catch (err) {
      publish({ kind: 'halted', reason: (err as Error).message, lastSeq: head.seq });
      return;
    }
    remaining = (await outboxList()).length;
    publish({ kind: 'draining', remaining });
  }

  publish({ kind: 'idle' });
}

async function readEntryBlobOrThrow(seq: number): Promise<Blob> {
  const { readEntryBlob } = await import('./outbox.ts');
  const blob = await readEntryBlob(seq);
  if (!blob) throw new Error(`outbox entry ${seq} has no blob`);
  return blob;
}
/* v8 ignore stop */
