import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { _resetGitHashCache } from '../../src/lib/build-info.ts';
import { bundleVersion } from '../../src/templates/layout.ts';

// resolveGitHash() is process-cached, so each test that depends on a
// specific GIT_HASH env value must clear the cache afterwards or
// subsequent tests pick up the previous value.
afterEach(() => {
  _resetGitHashCache();
});

test('bundleVersion: ?v=<12-char short hash> when GIT_HASH is set', () => {
  const prev = process.env.GIT_HASH;
  process.env.GIT_HASH = 'abcdef0123456789abcdef0123456789abcdef01';
  try {
    assert.equal(bundleVersion(), '?v=abcdef012345');
  } finally {
    if (prev === undefined) delete process.env.GIT_HASH;
    else process.env.GIT_HASH = prev;
  }
});

test('bundleVersion: produces a stable ?v= suffix per process', () => {
  // Whatever the resolver returns (real hash from .git or 'unknown'),
  // two calls in the same process return the same string. That's the
  // SW-caching contract: one deploy = one cache key.
  assert.equal(bundleVersion(), bundleVersion());
});
