// Pure types + coalescing logic for the offline-write outbox. Lives
// in src/lib/ so c8 measures it; the OPFS-coupled append/drain
// machinery is admin-side in src/admin/outbox.ts.
//
// The outbox is a sequenced queue of pending API calls. Each entry
// is one of four ops; spec-offline.md §5 has the full table.

import type { SidecarOp } from './sidecar-types.ts';

/** @public */
export type OutboxOp = 'upload' | 'setOps' | 'bake' | 'savePost';

/** @public */
export interface SavePostPayload {
  slug: string;
  title: string;
  status: 'draft' | 'published';
  date?: string;
  markdown: string;
  /** The meta.lastSyncedAt the client believed the server had at
   * the time the offline edits BEGAN — sent as
   * X-Rkr-Last-Synced-At so the server can detect concurrent edits.
   * Optional for fresh posts that have never been synced. */
  lastSyncedAt?: string;
}

/** @public */
export interface SetOpsPayload {
  id: string;
  ops: SidecarOp[];
  redoStack: SidecarOp[];
}

/** @public */
export interface BakePayload {
  id: string;
  /** sha256 hex of canonicalJson(ops). The blob (the bake bytes)
   * lives at opfs://outbox-blobs/<seq>.bin; this is just the
   * X-Rkr-Bake-Ops-Hash header value. */
  opsHash: string;
}

/** @public */
export interface UploadPayload {
  /** Content-addressed id (sha256 of the bytes); set client-side
   * at append time so subsequent outbox entries can reference it
   * before the upload drains. The server returns the same id on
   * drain (spec.md §3 — content-addressed identity is stable
   * across client + server). */
  id: string;
  /** Original filename for setStatus messages + multipart name. */
  filename: string;
  /** image/jpeg, image/png, etc. — passed through to /admin/upload's
   * multipart Content-Type. */
  mimeType: string;
}

interface OutboxEntryBase {
  seq: number;
  /** ISO-8601 timestamp at which the entry was appended. */
  createdAt: string;
  /** _root.json#deviceId so multi-device sync can attribute origin. */
  deviceId: string;
  /** When the entry was created from a draft, the draftId so we can
   * scope coalescing + cascading-failure cleanup. */
  draftId?: string;
}

export type OutboxEntry =
  | (OutboxEntryBase & { op: 'upload'; payload: UploadPayload })
  | (OutboxEntryBase & { op: 'setOps'; payload: SetOpsPayload })
  | (OutboxEntryBase & { op: 'bake'; payload: BakePayload })
  | (OutboxEntryBase & { op: 'savePost'; payload: SavePostPayload });

/** Coalesce: when the not-yet-drained queue contains multiple
 * `savePost` entries for the same slug, keep only the latest. Same
 * for `setOps` entries targeting the same image id. Older entries
 * are redundant by definition — the latest carries the final
 * state.
 *
 * Returns the entries that should remain; the caller deletes the
 * dropped entries from OPFS. Causal order is preserved by keeping
 * the latest seq for each (op, key) pair.
 *
 * `upload` and `bake` are NOT coalesced — content-addressed
 * uploads are idempotent on the server side (deduplicated:true is
 * just a no-op), and bake rejects on stale ops-hash so two bakes
 * for the same id with different ops both need to drain. */
export function coalescePending(entries: readonly OutboxEntry[]): OutboxEntry[] {
  // For each coalescable key, remember the latest seq seen.
  const latestSavePost = new Map<string, number>();
  const latestSetOps = new Map<string, number>();
  for (const e of entries) {
    if (e.op === 'savePost') {
      const prev = latestSavePost.get(e.payload.slug);
      if (prev === undefined || e.seq > prev) {
        latestSavePost.set(e.payload.slug, e.seq);
      }
    } else if (e.op === 'setOps') {
      const prev = latestSetOps.get(e.payload.id);
      if (prev === undefined || e.seq > prev) {
        latestSetOps.set(e.payload.id, e.seq);
      }
    }
  }
  // Filter: keep an entry iff its seq matches the latest for its
  // key (or it's not a coalescable op at all).
  return entries.filter((e) => {
    if (e.op === 'savePost') return latestSavePost.get(e.payload.slug) === e.seq;
    if (e.op === 'setOps') return latestSetOps.get(e.payload.id) === e.seq;
    return true;
  });
}
