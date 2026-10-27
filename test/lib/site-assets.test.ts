import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { _resetGitHashCache } from '../../src/lib/build-info.ts';
import { serverAssets } from '../../src/lib/site-assets.ts';
import { _resetThemeNameCache } from '../../src/lib/themes.ts';

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

test('serverAssets: a site theme gets a themeHref under the matching base', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-site-assets-'));
  fs.mkdirSync(path.join(root, 'themes'));
  fs.writeFileSync(path.join(root, 'themes', 'club.css'), 'body{}');
  const prev = { root: process.env.SITE_ROOT, theme: process.env.SITE_THEME };
  process.env.SITE_ROOT = root;
  process.env.SITE_THEME = 'club';
  t.after(() => {
    for (const [k, v] of [
      ['SITE_ROOT', prev.root],
      ['SITE_THEME', prev.theme]
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(serverAssets().themeHref, '/site-theme/club.css');
  assert.equal(serverAssets('/admin/static').themeHref, '/admin/site-theme/club.css');
});

test('serverAssets: a bundled theme leaves themeHref unset', () => {
  assert.equal(serverAssets().themeHref, undefined);
});

test('serverAssets: base is overridable for the admin shell', () => {
  assert.equal(serverAssets('/admin/static').base, '/admin/static');
});
