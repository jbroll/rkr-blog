// Server-side outbox idempotency store (Task 8, Must-fix #2).
//
// The offline client stamps drained POSTs with (x-rkr-device-id,
// x-rkr-outbox-seq). A lost-ACK (server committed, response dropped)
// makes the client replay the same entry. We record the original HTTP
// status + body keyed by (device_id, seq); a replay short-circuits to
// the stored result instead of re-running the mtime/X-Rkr-Last-Synced-At
// guard with a stale baked-in lastSyncedAt — which would 409 falsely and
// let the user "discard" a phantom conflict, dropping a newer coalesced
// edit (data loss).
//
// Bounded by pruneApplied (7-day retention) so the table stays small.
// Thin typed wrapper over the Db seam; no top-level side effects.

import type { Db } from './db.ts';

/** Rows older than this are eligible for pruning. A drained entry that
 * hasn't replayed within a week is past any realistic lost-ACK window. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface AppliedResult {
  status: number;
  body: string;
}

/** Record the result of a successfully applied drained entry. Uses
 * INSERT OR REPLACE so a defensive double-record (or a replay that
 * slips through before the lookup) overwrites rather than throwing on
 * the (device_id, seq) PRIMARY KEY. `appliedAt` defaults to now. */
export function recordApplied(
  db: Db,
  deviceId: string,
  seq: number,
  status: number,
  body: string,
  appliedAt: string = new Date().toISOString()
): void {
  db.prepare(
    `INSERT OR REPLACE INTO applied_outbox (device_id, seq, applied_at, status, body)
     VALUES (?, ?, ?, ?, ?)`
  ).run(deviceId, seq, appliedAt, status, body);
}

/** The stored {status, body} for a previously applied (device, seq),
 * or null if this entry has not been applied. */
export function lookupApplied(db: Db, deviceId: string, seq: number): AppliedResult | null {
  const row = db
    .prepare<{ status: number; body: string }>(
      'SELECT status, body FROM applied_outbox WHERE device_id = ? AND seq = ?'
    )
    .get(deviceId, seq);
  if (!row) return null;
  return { status: row.status, body: row.body };
}

/** Delete rows strictly older than the retention window relative to
 * `now` (defaults to the current time). Returns the number of rows
 * removed. Keeps the table bounded; called opportunistically after a
 * successful apply. */
export function pruneApplied(db: Db, now: string = new Date().toISOString()): number {
  const cutoff = new Date(Date.parse(now) - RETENTION_MS).toISOString();
  const r = db.prepare('DELETE FROM applied_outbox WHERE applied_at < ?').run(cutoff);
  return r.changes;
}
