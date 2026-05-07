import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { ingestStream } from '../../src/lib/originals.ts';
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
  assert.match(res.body, /<div id="rkroll-admin-root">/);
  assert.match(res.body, /<article id="rkroll-admin-article"><\/article>/);
  assert.match(res.body, /<script type="module" src="\/static\/admin\/main\.js"><\/script>/);

  // Public theme stylesheet is loaded so the editor preview matches the
  // rendered post — figures, prose width, gallery placeholder styles.
  assert.match(res.body, /<link rel="stylesheet" href="\/static\/site\.css"\/>/);

  // Security headers: CSP restricts script-src to self + esm.sh (the
  // editor's import map host); X-Content-Type-Options blocks MIME sniffing.
  const csp = res.headers['content-security-policy'] as string;
  assert.match(csp, /script-src 'self' https:\/\/esm\.sh/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
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

// ---- /admin/preview/:id -------------------------------------------------
// The editor's image node uses /admin/preview/<id> as its <img src>; the
// server redirects to the actual cached derivative URL. This avoids
// having the browser-side editor reproduce the cache-key calculation.

async function makeJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 100, height: 75, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

test('GET /admin/preview/:id 302s to the image-widget fallback URL', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: `/admin/preview/${ingest.id}` });
  assert.equal(res.statusCode, 302);
  const location = res.headers.location as string;
  // /img/<id>.<ophash>.jpeg — same scheme the public renderer uses, so a
  // single redirect lands on a URL Apache can serve directly when cached.
  assert.match(location, new RegExp(`^/img/${ingest.id}\\.[0-9a-f]{12}\\.jpeg$`));
});

test('GET /admin/preview/:id resolves a unique short-id prefix', async (t) => {
  const root = freshSiteRoot(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const prefix = ingest.id.slice(0, 12);
  const res = await app.inject({ method: 'GET', url: `/admin/preview/${prefix}` });
  assert.equal(res.statusCode, 302);
  const location = res.headers.location as string;
  // Redirect target uses the FULL id even when the request used a prefix.
  assert.match(location, new RegExp(`^/img/${ingest.id}\\.`));
});

test('GET /admin/preview/:id 400s on a malformed id', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/admin/preview/not-hex!' });
  assert.equal(res.statusCode, 400);
});

test('GET /admin/preview/:id 404s on an unknown but well-formed id', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const fakeId = 'd'.repeat(64);
  const res = await app.inject({ method: 'GET', url: `/admin/preview/${fakeId}` });
  assert.equal(res.statusCode, 404);
});

test('GET /admin/preview/:id 404s on an ambiguous short prefix', async (t) => {
  // Two ingests with hand-crafted sidecar files sharing a prefix; bypass
  // ingestStream so we can guarantee the prefix collision.
  const root = freshSiteRoot(t);
  const idA = `aaaaaa${'1'.repeat(58)}`;
  const idB = `aaaaaa${'2'.repeat(58)}`;
  for (const id of [idA, idB]) {
    fs.writeFileSync(
      path.join(root, 'sidecars', `${id}.json`),
      JSON.stringify({
        version: 1,
        original: id,
        source: { kind: 'upload', fetched: '2030-01-01T00:00:00Z' },
        metadata: { width: 100, height: 75, format: 'jpeg' },
        ops: [],
        outputs: [{ format: 'jpeg', quality: 85 }],
        variants: [{ w: 1200 }]
      })
    );
  }
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/admin/preview/aaaaaa' });
  assert.equal(res.statusCode, 404);
  assert.match(res.json<{ error: string }>().error, /ambiguous/);
});
