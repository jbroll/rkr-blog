import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { buildPrecache } from '../../scripts/gen-precache.ts';
import { renderAdminPage } from '../../src/templates/admin.ts';
import { renderPostPage } from '../../src/templates/post.ts';

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
  fs.writeFileSync(path.join(root, 'static', 'admin', 'opfs-worker.js'), '//');
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
  assert.ok(assets.includes('/admin/static/admin/main.js'));
  assert.ok(assets.includes('/admin/static/admin/chunk-ABC123.js'));
  assert.ok(assets.includes('/admin/static/admin/main.css'));
  assert.ok(!assets.some((a) => a.includes('.map')), 'sourcemaps excluded');
});

test('buildPrecache: split chunks are cached bare — a relative import drops the query', (t) => {
  const { assets } = buildPrecache(fixtureRepo(t), 'abcdef012345');
  assert.ok(assets.includes('/admin/static/admin/chunk-ABC123.js'));
  assert.ok(
    !assets.includes('/admin/static/admin/chunk-ABC123.js?v=abcdef012345'),
    'nothing requests a chunk with a query'
  );
  assert.ok(
    !assets.includes('/admin/static/admin/opfs-worker.js?v=abcdef012345'),
    'the worker is constructed from a bare URL too'
  );
  assert.ok(assets.includes('/admin/static/admin/opfs-worker.js'));
});

test('buildPrecache: the two files the shell stamps by name are cached both ways', (t) => {
  const { assets } = buildPrecache(fixtureRepo(t), 'abcdef012345');
  for (const rel of ['admin/main.js', 'admin/main.css']) {
    assert.ok(assets.includes(`/admin/static/${rel}`), `${rel} bare missing`);
    assert.ok(assets.includes(`/admin/static/${rel}?v=abcdef012345`), `${rel} versioned missing`);
  }
});

test('buildPrecache: a missing stamped file throws instead of being silently skipped', (t) => {
  const root = fixtureRepo(t);
  fs.rmSync(path.join(root, 'static', 'admin', 'main.css'));
  assert.throws(() => buildPrecache(root, 'abcdef012345'), /main\.css/);
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

test('buildPrecache: every entry sits under /admin/static, and only build output is bare', (t) => {
  const { assets, hash } = buildPrecache(fixtureRepo(t), 'abcdef012345');
  assert.equal(hash, 'abcdef012345');
  for (const a of assets) {
    assert.ok(a.startsWith('/admin/static/'), a);
    if (a.endsWith('?v=abcdef012345')) continue;
    assert.ok(a.startsWith('/admin/static/admin/'), `${a} must be versioned`);
  }
});

test('buildPrecache: assets the shell requests by a fixed name stay versioned', (t) => {
  const { assets } = buildPrecache(fixtureRepo(t), 'abcdef012345');
  for (const rel of [
    'base.css',
    'themes/default.css',
    'themes/tufte.css',
    'favicon.ico',
    'icon-32.png',
    'admin-manifest.webmanifest',
    'site/sw-admin-register.js',
    'site/lightbox.css'
  ]) {
    assert.ok(assets.includes(`/admin/static/${rel}?v=abcdef012345`), `${rel} missing`);
    assert.ok(!assets.includes(`/admin/static/${rel}`), `${rel} should not be bare`);
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

/** Every href/src attribute value in the rendered HTML, so this test
 * fails the moment a template references an asset the two hand-
 * maintained lists (FIXED, STAMPED) in gen-precache.ts don't know
 * about — the same failure mode as the split-chunk bug, just caught
 * at test time instead of offline in the field. */
function extractAssetUrls(html: string): string[] {
  const urls: string[] = [];
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const url = m[1];
    if (url?.startsWith('/admin/static/')) urls.push(url);
  }
  return urls;
}

test('buildPrecache: every asset URL the admin + preview templates render is in the manifest', (t) => {
  const hash = 'abcdef012345';
  const theme = 'default';
  const assets = { theme, hash, base: '/admin/static' };
  const site = { title: 'Test Site' };

  const adminHtml = renderAdminPage({
    site,
    assets,
    bundleUrl: '/admin/static/admin/main.js?v=abcdef012345',
    cspNonce: 'n'
  });
  // scripts: false matches what the preview actually requests
  // (renderPreviewDocument in src/admin/preview-page.ts).
  const previewHtml = renderPostPage({
    site,
    assets,
    title: 'A post',
    slug: 'a-post',
    bodyHtml: '<p>body</p>',
    isAdmin: true,
    showComments: false,
    scripts: false
  });

  const requested = new Set([...extractAssetUrls(adminHtml), ...extractAssetUrls(previewHtml)]);
  assert.ok(requested.size > 0, 'sanity: templates emit at least one /admin/static/ URL');

  const { assets: manifest } = buildPrecache(fixtureRepo(t), hash);
  for (const url of requested) {
    assert.ok(manifest.includes(url), `${url} is requested but not precached`);
  }
});
