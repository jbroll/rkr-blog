import assert from 'node:assert/strict';
import { test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import {
  createSession,
  deleteSession,
  deleteUserSessions,
  pruneExpired,
  readSession,
  readSessionUser,
  touchSession
} from '../../src/lib/sessions.ts';
import { findOrCreateOAuthUser, inviteEmail } from '../../src/lib/users.ts';

function freshDb() {
  const db = open(':memory:');
  migrate(db);
  return db;
}

function bootstrapUser(db: ReturnType<typeof open>, email = 'a@x.com', sub = 'g-1') {
  inviteEmail(db, email, 'owner');
  return findOrCreateOAuthUser(db, { provider: 'google', sub, email });
}

test('createSession returns a 64-hex id and writes the row', () => {
  const db = freshDb();
  try {
    const user = bootstrapUser(db);
    const s = createSession(db, { userId: user.id, ip: '127.0.0.1', userAgent: 'curl' });
    assert.match(s.id, /^[0-9a-f]{64}$/);
    assert.equal(s.user_id, user.id);
    assert.equal(s.ip, '127.0.0.1');

    const row = readSession(db, s.id);
    assert.deepEqual(row, s);
  } finally {
    db.close();
  }
});

test('readSession returns null for unknown ids', () => {
  const db = freshDb();
  try {
    assert.equal(readSession(db, 'a'.repeat(64)), null);
  } finally {
    db.close();
  }
});

test('readSession deletes and returns null for an expired session', () => {
  const db = freshDb();
  try {
    const user = bootstrapUser(db);
    const s = createSession(db, { userId: user.id, ttlMs: 1 });
    // Wait past expiry.
    const past = new Date(Date.now() - 1000).toISOString();
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(past, s.id);

    assert.equal(readSession(db, s.id), null);
    // The expired row was pruned in the read path.
    assert.equal(
      db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(s.id)?.n,
      0
    );
  } finally {
    db.close();
  }
});

test('readSessionUser returns paired session + user', () => {
  const db = freshDb();
  try {
    const user = bootstrapUser(db);
    const s = createSession(db, { userId: user.id });
    const r = readSessionUser(db, s.id);
    assert.ok(r);
    assert.equal(r?.user.id, user.id);
    assert.equal(r?.session.id, s.id);
  } finally {
    db.close();
  }
});

test('readSessionUser returns null when session missing', () => {
  const db = freshDb();
  try {
    assert.equal(readSessionUser(db, 'a'.repeat(64)), null);
  } finally {
    db.close();
  }
});

test('touchSession updates last_seen_at', () => {
  const db = freshDb();
  try {
    const user = bootstrapUser(db);
    const s = createSession(db, { userId: user.id });
    touchSession(db, s.id, '2030-01-01T00:00:00Z');
    assert.equal(readSession(db, s.id)?.last_seen_at, '2030-01-01T00:00:00Z');
  } finally {
    db.close();
  }
});

test('deleteSession removes the row', () => {
  const db = freshDb();
  try {
    const user = bootstrapUser(db);
    const s = createSession(db, { userId: user.id });
    deleteSession(db, s.id);
    assert.equal(readSession(db, s.id), null);
  } finally {
    db.close();
  }
});

test('deleteUserSessions drops every session for a user', () => {
  const db = freshDb();
  try {
    const user = bootstrapUser(db);
    createSession(db, { userId: user.id });
    createSession(db, { userId: user.id });
    const dropped = deleteUserSessions(db, user.id);
    assert.equal(dropped, 2);
  } finally {
    db.close();
  }
});

test('pruneExpired removes only sessions past expiry', () => {
  const db = freshDb();
  try {
    const user = bootstrapUser(db);
    const future = createSession(db, { userId: user.id });
    const expired = createSession(db, { userId: user.id });
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      expired.id
    );
    const removed = pruneExpired(db);
    assert.equal(removed, 1);
    assert.ok(readSession(db, future.id));
  } finally {
    db.close();
  }
});

test('readSession returns null for sessions older than the 90-day hard cap', () => {
  const db = freshDb();
  try {
    const user = bootstrapUser(db);
    const s = createSession(db, { userId: user.id });
    // Backdate created_at to 91 days ago (within rolling TTL but over the hard cap).
    const oldDate = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(oldDate, s.id);

    assert.equal(readSession(db, s.id), null);
    // The over-cap row was pruned.
    assert.equal(
      db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(s.id)?.n,
      0
    );
  } finally {
    db.close();
  }
});

test('cascade: deleting a user removes their sessions', () => {
  const db = freshDb();
  try {
    const user = bootstrapUser(db);
    const s = createSession(db, { userId: user.id });
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    assert.equal(readSession(db, s.id), null);
  } finally {
    db.close();
  }
});
