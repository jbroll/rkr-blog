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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-editor-bundle-'));
  fs.writeFileSync(path.join(dir, 'main.js'), 'console.log("test bundle");');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('GET /admin/editor returns the SPA shell HTML pointing at /admin/static/main.js', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/admin/editor' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  assert.match(res.body, /<div id="rkroll-admin-root"><\/div>/);
  assert.match(res.body, /<script type="module" src="\/admin\/static\/main\.js"><\/script>/);
});

test('GET /admin/static/main.js serves the compiled bundle when present', async (t) => {
  const root = freshSiteRoot(t);
  const bundleDir = writeBundle(t);
  const app = await buildApp({ siteRoot: root, adminBundleDir: bundleDir });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/admin/static/main.js' });
  assert.equal(res.statusCode, 200);
  assert.match(
    res.headers['content-type'] as string,
    /(application|text)\/javascript|application\/octet-stream/
  );
  assert.match(res.body, /test bundle/);
});

test('GET /admin/static/main.js 404s when the bundle directory does not exist', async (t) => {
  const root = freshSiteRoot(t);
  const missing = path.join(root, 'no-such-bundle-dir');
  const app = await buildApp({ siteRoot: root, adminBundleDir: missing });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/admin/static/main.js' });
  assert.equal(res.statusCode, 404);
});
