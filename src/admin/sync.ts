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

/** Thrown by drainSavePost when /admin/posts returns 409
 * post-superseded. drainLoop catches it via instanceof and publishes
 * a `conflict` DrainStatus carrying { slug, seq, serverUpdatedAt,
 * clientLastSyncedAt }. Lives here (not in drainers.ts) so drainers
 * can import this value without a circular module graph — sync.ts
 * already owns the public DrainStatus type that the error feeds.
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

/** Resolve a `conflict` status by discarding the local edit. Drops
 * the queued savePost outbox entry and re-runs the drain so any
 * downstream entries for OTHER posts can advance. Surfaces a fresh
 * `idle` / `draining` status. Spec-offline §6 — discard option.
 * @public */
export async function discardConflictedSave(): Promise<void> {
  /* v8 ignore next 4 -- conflict path lands fully in phase 1k+1l */
  if (currentStatus.kind !== 'conflict') return;
  await outboxRemove({ seq: currentStatus.seq, op: 'savePost' });
  publish({ kind: 'idle' });
  await tryDrain();
}

/** Resolve a `conflict` status by force-overwriting the server. Re-
 * POSTs /admin/posts WITHOUT X-Rkr-Last-Synced-At so the server
 * accepts unconditionally (spec-offline §6 — force option). Removes
 * the entry on 2xx, keeps it on failure (the user can retry).
 * @public */
export async function forceConflictedSave(): Promise<void> {
  /* v8 ignore start -- conflict path lands fully in phase 1k+1l */
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
      // Bake entries carry their blob via outbox-blobs/<seq>.bin
      // (image-edit.ts:commitOffline passes blob to outboxAppend).
      // Upload entries store bytes in opfs://originals/<id>.<ext>
      // for offline-preview reuse, so the upload drainer reads from
      // there itself; sync passes null.
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
}

async function readEntryBlobOrThrow(seq: number): Promise<Blob> {
  const { readEntryBlob } = await import('./outbox.ts');
  const blob = await readEntryBlob(seq);
  if (!blob) throw new Error(`outbox entry ${seq} has no blob`);
  return blob;
}
/* v8 ignore stop */
