-- Server-side outbox idempotency (Task 8). A drained outbox entry is
-- keyed by (device_id, seq); we record the original HTTP status + body
-- so a lost-ACK replay short-circuits to the stored 2xx instead of
-- re-evaluating the mtime/X-Rkr-Last-Synced-At guard and 409-ing with a
-- stale baked-in lastSyncedAt (which would let the user "discard" a
-- phantom conflict and drop a newer coalesced edit — data loss).
-- Bounded by pruneApplied (7-day retention) so the table stays small.

CREATE TABLE IF NOT EXISTS applied_outbox (
  device_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  status     INTEGER NOT NULL,
  body       TEXT NOT NULL,
  PRIMARY KEY (device_id, seq)
);
