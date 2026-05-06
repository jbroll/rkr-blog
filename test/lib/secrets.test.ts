import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import {
  decrypt,
  encrypt,
  ensureSecretKey,
  readSecretKey,
  secretKeyPath
} from '../../src/lib/secrets.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-secrets-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('ensureSecretKey generates a 32-byte key with mode 0600 on first call', (t) => {
  const root = freshSiteRoot(t);
  const created = ensureSecretKey(root);
  assert.equal(created, true);
  const file = secretKeyPath(root);
  const stat = fs.statSync(file);
  assert.equal(stat.size, 32);
  // POSIX mode bits — only check the lower nine.
  assert.equal(stat.mode & 0o777, 0o600);
});

test('ensureSecretKey is idempotent and does not regenerate the key', (t) => {
  const root = freshSiteRoot(t);
  ensureSecretKey(root);
  const before = fs.readFileSync(secretKeyPath(root));

  const second = ensureSecretKey(root);
  assert.equal(second, false);
  const after = fs.readFileSync(secretKeyPath(root));
  assert.deepEqual(after, before);
});

test('readSecretKey rejects a key file with wrong length', (t) => {
  const root = freshSiteRoot(t);
  fs.writeFileSync(secretKeyPath(root), Buffer.alloc(7));
  assert.throws(() => readSecretKey(root), /must be exactly 32 bytes/);
});

test('encrypt → decrypt round-trips arbitrary UTF-8 strings', (t) => {
  const root = freshSiteRoot(t);
  ensureSecretKey(root);
  const key = readSecretKey(root);
  for (const plaintext of ['', 'hello', 'unicode 🎉 ümlaut', 'a'.repeat(10_000)]) {
    const blob = encrypt(plaintext, key);
    assert.equal(decrypt(blob, key), plaintext);
  }
});

test('encrypt produces unique ciphertext per call (random IV)', (t) => {
  const root = freshSiteRoot(t);
  ensureSecretKey(root);
  const key = readSecretKey(root);
  const a = encrypt('same plaintext', key);
  const b = encrypt('same plaintext', key);
  assert.notDeepEqual(a, b);
});

test('decrypt fails on tampered ciphertext (auth-tag mismatch)', (t) => {
  const root = freshSiteRoot(t);
  ensureSecretKey(root);
  const key = readSecretKey(root);
  const blob = encrypt('secret payload', key);
  // Flip a bit in the ciphertext region (after IV + tag).
  blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 0x01;
  assert.throws(() => decrypt(blob, key));
});

test('decrypt fails on truncated ciphertext', (t) => {
  const root = freshSiteRoot(t);
  ensureSecretKey(root);
  const key = readSecretKey(root);
  assert.throws(() => decrypt(Buffer.alloc(5), key), /too short/);
});
