// Resolution order tests for resolveGitHash().

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { _resetGitHashCache, resolveGitHash } from '../../src/lib/build-info.ts';

function withEnv(t: TestContext, vars: Record<string, string | undefined>): void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetGitHashCache();
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetGitHashCache();
  });
}

const FAKE_SHA = 'abcdef1234567890abcdef1234567890abcdef12';

test('GIT_HASH env wins when set to a valid SHA', (t) => {
  withEnv(t, { GIT_HASH: FAKE_SHA, GIT_HASH_FILE: undefined });
  assert.equal(resolveGitHash(), FAKE_SHA);
});

test('GIT_HASH env is ignored when not a valid SHA shape', (t) => {
  // 'main' is a branch name, not a SHA — fall through to the other
  // resolvers. We expect a real SHA from the running .git tree (this
  // test executes inside the repo) — assert that it's not 'main'.
  withEnv(t, { GIT_HASH: 'main', GIT_HASH_FILE: undefined });
  const resolved = resolveGitHash();
  assert.notEqual(resolved, 'main');
  assert.ok(resolved === 'unknown' || /^[0-9a-f]{7,40}$/.test(resolved));
});

test('GIT_HASH_FILE wins over .git/HEAD when set to a valid file', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-githash-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, 'git-hash');
  fs.writeFileSync(file, `${FAKE_SHA}\n`, 'utf8');
  withEnv(t, { GIT_HASH: undefined, GIT_HASH_FILE: file });
  assert.equal(resolveGitHash(), FAKE_SHA);
});

test('GIT_HASH_FILE pointing at non-existent file falls through', (t) => {
  withEnv(t, { GIT_HASH: undefined, GIT_HASH_FILE: '/no/such/file/path' });
  const resolved = resolveGitHash();
  // Should land on .git/HEAD resolution from the running repo.
  assert.ok(/^[0-9a-f]{7,40}$/.test(resolved), `expected a SHA, got: ${resolved}`);
});

test('GIT_HASH_FILE containing garbage falls through to .git/HEAD', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-githash-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, 'git-hash');
  fs.writeFileSync(file, 'not-a-sha-at-all\n', 'utf8');
  withEnv(t, { GIT_HASH: undefined, GIT_HASH_FILE: file });
  const resolved = resolveGitHash();
  assert.ok(/^[0-9a-f]{7,40}$/.test(resolved));
});

test('result is cached: second call returns same value', (t) => {
  withEnv(t, { GIT_HASH: FAKE_SHA, GIT_HASH_FILE: undefined });
  const first = resolveGitHash();
  // Mutate env after the first resolve — cached value should stick
  // until _resetGitHashCache().
  process.env.GIT_HASH = '0000000000000000000000000000000000000000';
  const second = resolveGitHash();
  assert.equal(second, first);
});
