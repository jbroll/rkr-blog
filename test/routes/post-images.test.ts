// End-to-end regression test: a post with image directives must render
// HTML whose every <img src> is reachable on the same server. Catches
// the class of bug where the widget's emitted URL doesn't line up with
// what /img/ knows how to serve (sidecar variants × outputs missing the
// fallback). The widget-fallback-alignment.test.ts test covers the
// constants relationship; this test is the actual round-trip.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { ingestStream } from '../../src/lib/originals.ts';
import { buildApp } from '../../src/server.ts';

async function makeJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 90, g: 30, b: 200 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-post-images-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function setup(t: TestContext) {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  t.after(() => db.close());
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(() => app.close());
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });
  return { root, app, imageId: ingest.id };
}

/** Pull every distinct /img/... URL out of the rendered HTML. */
function imageUrls(html: string): string[] {
  const re = /(?:src|srcset)="([^"]+)"/g;
  const urls = new Set<string>();
  for (const m of html.matchAll(re)) {
    const value = m[1] ?? '';
    // srcset may carry comma-separated `<url> <descriptor>` pairs.
    for (const part of value.split(',')) {
      const u = part.trim().split(/\s+/)[0] ?? '';
      if (u.startsWith('/img/')) urls.add(u);
    }
  }
  return [...urls];
}

test('::image: every <img src> + every srcset entry resolves to 200', async (t) => {
  const { app, imageId } = await setup(t);

  const post = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'pic-roundtrip',
      title: 'Pic roundtrip',
      status: 'published',
      markdown: `Body before.\n\n::image{#${imageId} alt="hi"}\n\nBody after.\n`
    }
  });
  assert.equal(post.statusCode, 200, post.body);

  const page = await app.inject({ method: 'GET', url: '/pic-roundtrip' });
  assert.equal(page.statusCode, 200);
  const urls = imageUrls(page.body);
  // image widget: 3 srcset widths × 2 source-formats (webp+avif) + 1
  // <img src> fallback (jpeg). At minimum we expect the fallback to be
  // present; the srcsets too if @fastify rendered them as expected.
  assert.ok(urls.length >= 1, `no image URLs in rendered HTML: ${page.body}`);

  for (const url of urls) {
    const res = await app.inject({ method: 'GET', url });
    // 200 (just rendered) or 202 (queued for async render). Both mean
    // the URL was understood. 404 means the widget emitted a URL the
    // server can't satisfy — the bug we're guarding against.
    assert.ok(
      res.statusCode === 200 || res.statusCode === 202,
      `${url} → ${res.statusCode}: ${res.body}`
    );
  }
});

test('::diptych: every <img src> + every srcset entry resolves', async (t) => {
  const { app, imageId } = await setup(t);
  // Reuse the same id twice — the post will reference one logical image
  // for both diptych slots, which is enough to exercise the widget.
  const post = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'dip-roundtrip',
      title: 'Diptych roundtrip',
      status: 'published',
      markdown: `::diptych{ids="${imageId},${imageId}"}\n`
    }
  });
  assert.equal(post.statusCode, 200, post.body);

  const page = await app.inject({ method: 'GET', url: '/dip-roundtrip' });
  assert.equal(page.statusCode, 200);
  const urls = imageUrls(page.body);
  assert.ok(urls.length >= 1, `no image URLs: ${page.body}`);
  for (const url of urls) {
    const res = await app.inject({ method: 'GET', url });
    assert.ok(
      res.statusCode === 200 || res.statusCode === 202,
      `${url} → ${res.statusCode}: ${res.body}`
    );
  }
});

test('::gallery: every <img src> + every srcset entry resolves', async (t) => {
  const { app, imageId } = await setup(t);
  const post = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'gal-roundtrip',
      title: 'Gallery roundtrip',
      status: 'published',
      markdown: `::gallery{ids="${imageId},${imageId},${imageId}"}\n`
    }
  });
  assert.equal(post.statusCode, 200, post.body);

  const page = await app.inject({ method: 'GET', url: '/gal-roundtrip' });
  assert.equal(page.statusCode, 200);
  const urls = imageUrls(page.body);
  assert.ok(urls.length >= 1, `no image URLs: ${page.body}`);
  for (const url of urls) {
    const res = await app.inject({ method: 'GET', url });
    assert.ok(
      res.statusCode === 200 || res.statusCode === 202,
      `${url} → ${res.statusCode}: ${res.body}`
    );
  }
});
