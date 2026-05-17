// Server-side outbox idempotency store (Task 8). In-memory Db seam +
// real migrations, mirroring test/lib/sessions.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lookupApplied, pruneApplied, recordApplied } from '../../src/lib/applied-outbox.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';

function freshDb() {
  const db = open(':memory:');
  migrate(db);
  return db;
}

test('lookupApplied: miss → null', () => {
  const db = freshDb();
  try {
    assert.equal(lookupApplied(db, 'dev-1', 1), null);
  } finally {
    db.close();
  }
});

test('recordApplied then lookupApplied returns stored {status,body}', () => {
  const db = freshDb();
  try {
    recordApplied(db, 'dev-1', 7, 200, '{"slug":"hello","inserted":false}');
    assert.deepEqual(lookupApplied(db, 'dev-1', 7), {
      status: 200,
      body: '{"slug":"hello","inserted":false}'
    });
    // Distinct device or seq is a miss.
    assert.equal(lookupApplied(db, 'dev-2', 7), null);
    assert.equal(lookupApplied(db, 'dev-1', 8), null);
  } finally {
    db.close();
  }
});

test('recordApplied twice for same (device,seq): second overwrites (INSERT OR REPLACE)', () => {
  const db = freshDb();
  try {
    recordApplied(db, 'dev-1', 3, 200, 'first');
    // A replay that somehow re-records (defensive) must not throw on the
    // PRIMARY KEY conflict; INSERT OR REPLACE keeps the latest.
    recordApplied(db, 'dev-1', 3, 201, 'second');
    assert.deepEqual(lookupApplied(db, 'dev-1', 3), { status: 201, body: 'second' });
  } finally {
    db.close();
  }
});

test('pruneApplied drops rows older than the 7-day retention, keeps recent', () => {
  const db = freshDb();
  try {
    const now = Date.parse('2026-05-17T12:00:00.000Z');
    const old = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days
    const recent = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day
    recordApplied(db, 'dev-old', 1, 200, 'stale', old);
    recordApplied(db, 'dev-new', 2, 200, 'fresh', recent);

    const removed = pruneApplied(db, new Date(now).toISOString());
    assert.equal(removed, 1);
    assert.equal(lookupApplied(db, 'dev-old', 1), null);
    assert.deepEqual(lookupApplied(db, 'dev-new', 2), { status: 200, body: 'fresh' });
  } finally {
    db.close();
  }
});

test('pruneApplied at the exact 7-day boundary keeps the row (strictly older only)', () => {
  const db = freshDb();
  try {
    const now = Date.parse('2026-05-17T12:00:00.000Z');
    const exactly7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    recordApplied(db, 'dev-edge', 1, 200, 'edge', exactly7d);
    const removed = pruneApplied(db, new Date(now).toISOString());
    assert.equal(removed, 0);
    assert.deepEqual(lookupApplied(db, 'dev-edge', 1), { status: 200, body: 'edge' });
  } finally {
    db.close();
  }
});

test('recordApplied/pruneApplied default the timestamp/now to the current time', () => {
  const db = freshDb();
  try {
    // No appliedAt arg → defaults to now; prune with no `now` arg →
    // defaults to now; a just-recorded row is well within retention.
    recordApplied(db, 'dev-default', 5, 200, 'kept');
    const removed = pruneApplied(db);
    assert.equal(removed, 0);
    assert.deepEqual(lookupApplied(db, 'dev-default', 5), { status: 200, body: 'kept' });
  } finally {
    db.close();
  }
});
