import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { _resetGitHashCache } from '../../src/lib/build-info.ts';
import { _resetThemeNameCache } from '../../src/lib/config.ts';
import { serverAssets } from '../../src/lib/site-assets.ts';

afterEach(() => {
  _resetGitHashCache();
  _resetThemeNameCache();
});

test('serverAssets: hash is the 12-char git short hash, base defaults to /static', () => {
  const prev = process.env.GIT_HASH;
  process.env.GIT_HASH = 'abcdef0123456789abcdef0123456789abcdef01';
  try {
    const a = serverAssets();
    assert.equal(a.hash, 'abcdef012345');
    assert.equal(a.base, '/static');
    assert.equal(typeof a.theme, 'string');
  } finally {
    if (prev === undefined) delete process.env.GIT_HASH;
    else process.env.GIT_HASH = prev;
  }
});

test('serverAssets: base is overridable for the admin shell', () => {
  assert.equal(serverAssets('/admin/static').base, '/admin/static');
});
