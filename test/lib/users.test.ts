import assert from 'node:assert/strict';
import { test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import {
  EmailLinkedError,
  findOrCreateOAuthUser,
  findUserByEmail,
  findUserById,
  inviteEmail,
  isAllowed,
  listInvites,
  listUsers,
  NotInvitedError,
  removeInvite,
  touchLastSeen,
  userCount
} from '../../src/lib/users.ts';

function freshDb() {
  const db = open(':memory:');
  migrate(db);
  return db;
}

test('inviteEmail / isAllowed / removeInvite / listInvites round-trip', () => {
  const db = freshDb();
  try {
    inviteEmail(db, 'A@Example.com', 'editor');
    const allowed = isAllowed(db, 'a@example.com');
    assert.ok(allowed);
    assert.equal(allowed?.email, 'a@example.com');
    assert.equal(allowed?.role, 'editor');

    inviteEmail(db, 'b@example.com', 'owner');
    assert.equal(listInvites(db).length, 2);

    assert.equal(removeInvite(db, 'A@Example.com'), true);
    assert.equal(removeInvite(db, 'no-such@example.com'), false);
    assert.equal(listInvites(db).length, 1);
  } finally {
    db.close();
  }
});

test('inviteEmail upserts: inviting again updates role', () => {
  const db = freshDb();
  try {
    inviteEmail(db, 'a@example.com', 'editor');
    inviteEmail(db, 'a@example.com', 'owner');
    const allow = isAllowed(db, 'a@example.com');
    assert.equal(allow?.role, 'owner');
    assert.equal(listInvites(db).length, 1, 'still one row');
  } finally {
    db.close();
  }
});

test('findOrCreateOAuthUser refuses an empty allowlist (no implicit owner)', () => {
  // Removing the old "first login becomes owner" bypass. The operator
  // must invite themselves via `site-admin user invite <email>
  // --role=owner` before logging in. Without an entry, every login
  // 401s — closing the deployment-window takeover risk.
  const db = freshDb();
  try {
    assert.equal(userCount(db), 0);
    assert.throws(
      () =>
        findOrCreateOAuthUser(db, {
          provider: 'google',
          sub: 'g-1',
          email: 'first@example.com',
          displayName: 'First'
        }),
      NotInvitedError
    );
    assert.equal(userCount(db), 0, 'no user created on rejected login');
  } finally {
    db.close();
  }
});

test('findOrCreateOAuthUser creates with allowlist role for the first invited user', () => {
  const db = freshDb();
  try {
    inviteEmail(db, 'owner@x.com', 'owner');
    const u = findOrCreateOAuthUser(db, {
      provider: 'google',
      sub: 'g-1',
      email: 'owner@x.com'
    });
    assert.equal(u.role, 'owner');
    assert.equal(userCount(db), 1);
  } finally {
    db.close();
  }
});

test('findOrCreateOAuthUser creates with allowlist role for subsequent users', () => {
  const db = freshDb();
  try {
    inviteEmail(db, 'owner@x.com', 'owner');
    findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'owner@x.com' });
    inviteEmail(db, 'editor@x.com', 'editor');
    const u = findOrCreateOAuthUser(db, {
      provider: 'google',
      sub: 'g-2',
      email: 'editor@x.com'
    });
    assert.equal(u.role, 'editor');
    assert.equal(userCount(db), 2);
  } finally {
    db.close();
  }
});

test('findOrCreateOAuthUser rejects an unknown email after bootstrap', () => {
  const db = freshDb();
  try {
    inviteEmail(db, 'owner@x.com', 'owner');
    findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'owner@x.com' });
    assert.throws(
      () =>
        findOrCreateOAuthUser(db, {
          provider: 'google',
          sub: 'g-2',
          email: 'stranger@x.com'
        }),
      NotInvitedError
    );
  } finally {
    db.close();
  }
});

test('findOrCreateOAuthUser returns existing user on second login (touches last_seen_at)', async () => {
  const db = freshDb();
  try {
    inviteEmail(db, 'a@x.com', 'owner');
    const u1 = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
    const before = u1.last_seen_at;
    await new Promise((r) => setTimeout(r, 5));
    const u2 = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
    assert.equal(u2.id, u1.id);
    assert.notEqual(findUserById(db, u1.id)?.last_seen_at, before);
  } finally {
    db.close();
  }
});

test('findOrCreateOAuthUser refuses to silently link a new provider via shared email', () => {
  // Security: with no authenticated linking flow, anyone who controls
  // victim@gmail.com on a newly-supported provider could otherwise
  // inherit the existing user's role. EmailLinkedError forces them to
  // log in via the original provider first; cross-provider linking
  // must be initiated from a session.
  const db = freshDb();
  try {
    inviteEmail(db, 'a@x.com', 'owner');
    findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
    assert.throws(
      () =>
        findOrCreateOAuthUser(db, {
          provider: 'apple',
          sub: 'a-1',
          email: 'a@x.com'
        }),
      EmailLinkedError
    );
    assert.equal(userCount(db), 1, 'no second user created');
  } finally {
    db.close();
  }
});

test('findOrCreateOAuthUser email lookup is NFKC-normalized', () => {
  // Two visually-identical Unicode forms: precomposed "Ä" (U+00C4) and
  // decomposed "A" + combining diaeresis (U+0041 U+0308). Without NFKC,
  // an attacker could invite the precomposed form and log in with the
  // decomposed form (or vice versa) to bypass the allowlist.
  const db = freshDb();
  try {
    inviteEmail(db, 'owner@x.com', 'owner');
    findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'owner@x.com' });
    inviteEmail(db, 'Änna@x.com', 'editor'); // precomposed
    const u = findOrCreateOAuthUser(db, {
      provider: 'google',
      sub: 'g-2',
      email: 'Änna@x.com' // decomposed — NFKC collapses to the same form
    });
    assert.equal(u.role, 'editor');
  } finally {
    db.close();
  }
});

test('findUserByEmail is case-insensitive on the lookup', () => {
  const db = freshDb();
  try {
    inviteEmail(db, 'mixed@case.com', 'owner');
    findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'Mixed@Case.COM' });
    assert.ok(findUserByEmail(db, 'mixed@case.com'));
    assert.ok(findUserByEmail(db, 'MIXED@CASE.COM'));
  } finally {
    db.close();
  }
});

test('listUsers returns rows in creation order', () => {
  const db = freshDb();
  try {
    inviteEmail(db, 'a@x.com', 'owner');
    findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
    inviteEmail(db, 'b@x.com', 'editor');
    findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-2', email: 'b@x.com' });
    const us = listUsers(db);
    assert.equal(us.length, 2);
    assert.equal(us[0]?.email, 'a@x.com');
    assert.equal(us[1]?.email, 'b@x.com');
  } finally {
    db.close();
  }
});

test('touchLastSeen updates the user row', () => {
  const db = freshDb();
  try {
    inviteEmail(db, 'a@x.com', 'owner');
    const u = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
    touchLastSeen(db, u.id, '2030-01-01T00:00:00Z');
    assert.equal(findUserById(db, u.id)?.last_seen_at, '2030-01-01T00:00:00Z');
  } finally {
    db.close();
  }
});
