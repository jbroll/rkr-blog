import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { buildApp } from '../../src/server.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-editor-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeBundle(t: TestContext): string {
  // Returns a directory laid out like the repo's static/: contains an
  // admin/main.js subpath that maps to /static/admin/main.js.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-editor-bundle-'));
  fs.mkdirSync(path.join(dir, 'admin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'admin', 'main.js'), 'console.log("test bundle");');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'admin');
}

test('GET /admin/editor returns the SPA shell HTML pointing at /static/admin/main.js', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/admin/editor' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  assert.match(res.body, /<div id="rkroll-admin-root"><\/div>/);
  assert.match(res.body, /<script type="module" src="\/static\/admin\/main\.js"><\/script>/);
});

test('GET /static/admin/main.js serves the compiled bundle when present', async (t) => {
  const root = freshSiteRoot(t);
  const bundleDir = writeBundle(t);
  const app = await buildApp({ siteRoot: root, adminBundleDir: bundleDir });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/static/admin/main.js' });
  assert.equal(res.statusCode, 200);
  assert.match(
    res.headers['content-type'] as string,
    /(application|text)\/javascript|application\/octet-stream/
  );
  assert.match(res.body, /test bundle/);
});

test('GET /static/admin/main.js 404s when the bundle directory does not exist', async (t) => {
  const root = freshSiteRoot(t);
  const missing = path.join(root, 'no-such-bundle-dir');
  const app = await buildApp({ siteRoot: root, adminBundleDir: missing });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/static/admin/main.js' });
  assert.equal(res.statusCode, 404);
});
