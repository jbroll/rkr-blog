import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { buildPrecache } from '../../scripts/gen-precache.ts';

function fixtureRepo(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-precache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'static', 'admin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'static', 'themes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'static', 'site'), { recursive: true });
  fs.writeFileSync(path.join(root, 'static', 'admin', 'main.js'), '//');
  fs.writeFileSync(path.join(root, 'static', 'admin', 'main.js.map'), '{}');
  fs.writeFileSync(path.join(root, 'static', 'admin', 'main.css'), '/* */');
  fs.writeFileSync(path.join(root, 'static', 'admin', 'chunk-ABC123.js'), '//');
  for (const name of ['default', 'tufte', 'dracula']) {
    fs.writeFileSync(path.join(root, 'static', 'themes', `${name}.css`), '/* */');
  }
  fs.writeFileSync(path.join(root, 'static', 'base.css'), '/* */');
  fs.writeFileSync(path.join(root, 'static', 'admin-manifest.webmanifest'), '{}');
  fs.writeFileSync(path.join(root, 'static', 'favicon.ico'), '');
  fs.writeFileSync(path.join(root, 'static', 'icon-32.png'), '');
  fs.writeFileSync(path.join(root, 'static', 'icon-192.png'), '');
  fs.writeFileSync(path.join(root, 'static', 'icon-512.png'), '');
  fs.writeFileSync(path.join(root, 'static', 'apple-touch-icon.png'), '');
  fs.writeFileSync(path.join(root, 'static', 'site', 'sw-admin-register.js'), '//');
  fs.writeFileSync(path.join(root, 'static', 'site', 'lightbox.css'), '/* */');
  return root;
}

test('buildPrecache: lists every emitted file under static/admin, sourcemaps excluded', (t) => {
  const { assets } = buildPrecache(fixtureRepo(t), 'abcdef012345');
  assert.ok(assets.includes('/admin/static/admin/main.js?v=abcdef012345'));
  assert.ok(assets.includes('/admin/static/admin/chunk-ABC123.js?v=abcdef012345'));
  assert.ok(assets.includes('/admin/static/admin/main.css?v=abcdef012345'));
  assert.ok(!assets.some((a) => a.includes('.map')), 'sourcemaps excluded');
});

test('buildPrecache: every theme sheet is listed', (t) => {
  const { assets } = buildPrecache(fixtureRepo(t), 'abcdef012345');
  for (const name of ['default', 'tufte', 'dracula']) {
    assert.ok(
      assets.includes(`/admin/static/themes/${name}.css?v=abcdef012345`),
      `${name} missing`
    );
  }
});

test('buildPrecache: every entry carries the ?v= suffix and the /admin/static prefix', (t) => {
  const { assets, hash } = buildPrecache(fixtureRepo(t), 'abcdef012345');
  assert.equal(hash, 'abcdef012345');
  for (const a of assets) {
    assert.ok(a.startsWith('/admin/static/'), a);
    assert.ok(a.endsWith('?v=abcdef012345'), a);
  }
});

test('buildPrecache: fixed assets the shell references are listed', (t) => {
  const { assets } = buildPrecache(fixtureRepo(t), 'abcdef012345');
  for (const rel of [
    'base.css',
    'admin-manifest.webmanifest',
    'favicon.ico',
    'icon-32.png',
    'apple-touch-icon.png',
    'site/sw-admin-register.js',
    'site/lightbox.css'
  ]) {
    assert.ok(assets.includes(`/admin/static/${rel}?v=abcdef012345`), `${rel} missing`);
  }
});

test('buildPrecache: a missing fixed asset throws instead of being silently skipped', (t) => {
  const root = fixtureRepo(t);
  fs.rmSync(path.join(root, 'static', 'site', 'lightbox.css'));
  assert.throws(() => buildPrecache(root, 'abcdef012345'), /lightbox\.css/);
});

test('buildPrecache: webmanifest icons are excluded — the browser fetches them unversioned', (t) => {
  const { assets } = buildPrecache(fixtureRepo(t), 'abcdef012345');
  assert.ok(
    !assets.some((a) => a.includes('icon-192.png')),
    'icon-192.png should not be precached'
  );
  assert.ok(
    !assets.some((a) => a.includes('icon-512.png')),
    'icon-512.png should not be precached'
  );
});
