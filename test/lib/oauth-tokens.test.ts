import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import {
  deleteToken,
  isExpired,
  readToken,
  type StoredOAuthToken,
  upsertToken
} from '../../src/lib/oauth-tokens.ts';
import { ensureSecretKey, readSecretKey } from '../../src/lib/secrets.ts';
import { findOrCreateOAuthUser } from '../../src/lib/users.ts';

function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-tokens-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  ensureSecretKey(root);
  const key = readSecretKey(root);
  const db = open(':memory:');
  migrate(db);
  const user = findOrCreateOAuthUser(db, {
    provider: 'google',
    sub: 'g-1',
    email: 'a@x.com'
  });
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, key, db, user };
}

test('upsertToken inserts a new row with encrypted access + refresh tokens', (t) => {
  const { db, key, user } = setup(t);

  upsertToken(db, key, {
    userId: user.id,
    provider: 'gdrive',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: '2030-01-01T00:00:00Z',
    scope: 'drive.file'
  });

  const row = readToken(db, key, user.id, 'gdrive');
  assert.ok(row);
  assert.equal(row?.access_token, 'access-1');
  assert.equal(row?.refresh_token, 'refresh-1');
  assert.equal(row?.expires_at, '2030-01-01T00:00:00Z');
  assert.equal(row?.scope, 'drive.file');

  // Stored bytes are not the plaintext.
  const raw = db
    .prepare<{ access_token: Buffer; refresh_token: Buffer | null }>(
      'SELECT access_token, refresh_token FROM oauth_tokens WHERE user_id=? AND provider=?'
    )
    .get(user.id, 'gdrive');
  assert.notEqual(raw?.access_token.toString('utf8'), 'access-1');
});

test('upsertToken updates an existing row; preserves refresh_token when not provided', (t) => {
  const { db, key, user } = setup(t);

  upsertToken(db, key, {
    userId: user.id,
    provider: 'gdrive',
    accessToken: 'a-1',
    refreshToken: 'r-1',
    expiresAt: '2030-01-01T00:00:00Z'
  });
  upsertToken(db, key, {
    userId: user.id,
    provider: 'gdrive',
    accessToken: 'a-2',
    expiresAt: '2030-02-01T00:00:00Z'
    // refreshToken intentionally omitted
  });

  const row = readToken(db, key, user.id, 'gdrive');
  assert.equal(row?.access_token, 'a-2');
  assert.equal(row?.refresh_token, 'r-1', 'refresh_token preserved across update');
  assert.equal(row?.expires_at, '2030-02-01T00:00:00Z');
});

test('readToken returns null when row absent', (t) => {
  const { db, key, user } = setup(t);
  assert.equal(readToken(db, key, user.id, 'gdrive'), null);
});

test('deleteToken removes the row and is idempotent', (t) => {
  const { db, key, user } = setup(t);
  upsertToken(db, key, {
    userId: user.id,
    provider: 'gdrive',
    accessToken: 'a',
    expiresAt: '2030-01-01T00:00:00Z'
  });
  assert.equal(deleteToken(db, user.id, 'gdrive'), true);
  assert.equal(deleteToken(db, user.id, 'gdrive'), false);
  assert.equal(readToken(db, key, user.id, 'gdrive'), null);
});

test('cascade: deleting the user drops their tokens', (t) => {
  const { db, key, user } = setup(t);
  upsertToken(db, key, {
    userId: user.id,
    provider: 'gdrive',
    accessToken: 'a',
    expiresAt: '2030-01-01T00:00:00Z'
  });
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  assert.equal(readToken(db, key, user.id, 'gdrive'), null);
});

test('isExpired returns true when expires_at is in the past', () => {
  const past: StoredOAuthToken = {
    user_id: 1,
    provider: 'gdrive',
    access_token: 'a',
    refresh_token: null,
    expires_at: new Date(Date.now() - 60_000).toISOString(),
    scope: null,
    created_at: '',
    updated_at: ''
  };
  assert.equal(isExpired(past), true);

  const future: StoredOAuthToken = {
    ...past,
    expires_at: new Date(Date.now() + 3600_000).toISOString()
  };
  assert.equal(isExpired(future), false);
});

test('isExpired honors clock-skew margin (default 30s)', () => {
  // 10 seconds in the future is "expired" under the default 30s skew.
  const almostExpired: StoredOAuthToken = {
    user_id: 1,
    provider: 'gdrive',
    access_token: 'a',
    refresh_token: null,
    expires_at: new Date(Date.now() + 10_000).toISOString(),
    scope: null,
    created_at: '',
    updated_at: ''
  };
  assert.equal(isExpired(almostExpired), true);
  assert.equal(isExpired(almostExpired, 0), false);
});
