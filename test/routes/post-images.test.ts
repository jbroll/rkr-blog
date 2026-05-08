// End-to-end regression test: a post with image directives must render
// HTML whose every <img src> is reachable on the same server. Catches
// the class of bug where the widget's emitted URL doesn't line up with
// what /img/ knows how to serve (sidecar variants × outputs missing the
// fallback). The widget-fallback-alignment.test.ts test covers the
// constants relationship; this test is the actual round-trip.
//
// Sampling: we fetch one URL per distinct image id, not all 7. A real
// browser only requests a single (variant, format) per image — picking
// one matches the production load pattern, runs ~7× faster, and the
// constants-alignment test already proves every emitted (variant,
// output) pair lines up with the sidecar's declarations. The pick is
// deterministic per-id (hash-of-id modulo URL count), so different ids
// hit different URLs without making CI runs flaky.

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

async function makeJpeg(seed = 0): Promise<Buffer> {
  return sharp({
    create: {
      width: 320 + seed,
      height: 240 + seed,
      channels: 3,
      background: { r: 90 + (seed % 100), g: 30, b: 200 - (seed % 100) }
    }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function ingestN(t: TestContext, root: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await ingestStream({
      stream: Readable.from([await makeJpeg(i)]),
      siteRoot: root,
      source: { kind: 'upload', originalName: `pic-${i}.jpg` }
    });
    ids.push(r.id);
  }
  void t; // siteRoot cleanup is owned by freshSiteRoot's t.after
  return ids;
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

/** Pull every distinct /img/<id>.<ophash>.<fmt> URL from the rendered
 * HTML, grouped by image id. */
function imageUrlsByImageId(html: string): Map<string, string[]> {
  const re = /(?:src|srcset)="([^"]+)"/g;
  const byId = new Map<string, string[]>();
  for (const m of html.matchAll(re)) {
    const value = m[1] ?? '';
    // srcset may carry comma-separated `<url> <descriptor>` pairs.
    for (const part of value.split(',')) {
      const u = part.trim().split(/\s+/)[0] ?? '';
      const idMatch = /^\/img\/([0-9a-f]+)\.[0-9a-f]+\.[a-z]+$/.exec(u);
      if (!idMatch) continue;
      const id = idMatch[1] as string;
      const list = byId.get(id) ?? [];
      if (!list.includes(u)) list.push(u);
      byId.set(id, list);
    }
  }
  return byId;
}

/** Pick one URL per image id, deterministically — hash-of-id mod
 * url-count means the same id always picks the same URL across runs
 * (no CI flake), but different ids hit different URLs so the test
 * corpus exercises a variety of (variant, output) combos. */
function sampleOneUrlPerImage(byId: Map<string, string[]>): string[] {
  const out: string[] = [];
  for (const [id, urls] of byId) {
    const sorted = [...urls].sort();
    const idx = Number.parseInt(id.slice(0, 8), 16) % sorted.length;
    out.push(sorted[idx] as string);
  }
  return out;
}

async function assertSampledImagesResolve(
  app: Awaited<ReturnType<typeof buildApp>>,
  html: string
): Promise<void> {
  const byId = imageUrlsByImageId(html);
  assert.ok(byId.size >= 1, `no image URLs in rendered HTML: ${html}`);
  const sample = sampleOneUrlPerImage(byId);
  for (const url of sample) {
    const res = await app.inject({ method: 'GET', url });
    // 200 (just rendered) or 202 (queued for async render). Both mean
    // the URL was understood. 404 means the widget emitted a URL the
    // server can't satisfy — the bug we're guarding against.
    assert.ok(
      res.statusCode === 200 || res.statusCode === 202,
      `${url} → ${res.statusCode}: ${res.body}`
    );
  }
}

test('::image: rendered <img>/<srcset> URLs resolve (sample one per image)', async (t) => {
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
  await assertSampledImagesResolve(app, page.body);
});

test('::diptych: rendered URLs resolve (sample one per image)', async (t) => {
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
  await assertSampledImagesResolve(app, page.body);
});

test('::gallery: rendered URLs resolve (sample one per image)', async (t) => {
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
  await assertSampledImagesResolve(app, page.body);
});

test('::figure (matrix=2x2): rendered URLs resolve (sample one per image)', async (t) => {
  // The unified directive (spec.md §9). Phase 1: matrix=NxM. Variants
  // and fallback declared by the figure widget are union of the legacy
  // widgets' shapes (constants-alignment test guards this), so emitted
  // URLs all resolve via the standard /img/ pipeline — same plumbing
  // the legacy ::image / ::diptych / ::gallery use.
  const { app, imageId } = await setup(t);
  const post = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'fig-roundtrip',
      title: 'Figure roundtrip',
      status: 'published',
      markdown: `::figure{ids="${imageId},${imageId},${imageId},${imageId}" matrix=2x2}\n`
    }
  });
  assert.equal(post.statusCode, 200, post.body);

  const page = await app.inject({ method: 'GET', url: '/fig-roundtrip' });
  assert.equal(page.statusCode, 200);
  // Sanity: the new directive renders the new shell + grid markers.
  assert.match(page.body, /class="rkr-figure rkr-justify-center rkr-fit-cover"/);
  assert.match(page.body, /<div class="rkr-figure-grid"/);
  await assertSampledImagesResolve(app, page.body);
});

test('::figure (matrix=masonry): rendered URLs resolve', async (t) => {
  // Phase 3: flow layout. Each cell renders a regular <picture>, so
  // /img/ resolution path is identical to grid mode; this test just
  // confirms the masonry branch reaches that path.
  const { app, root } = await setup(t);
  const ids = await ingestN(t, root, 4);
  const post = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'fig-masonry-roundtrip',
      title: 'Masonry roundtrip',
      status: 'published',
      markdown: `::figure{ids="${ids.join(',')}" matrix=masonry:3}\n`
    }
  });
  assert.equal(post.statusCode, 200, post.body);

  const page = await app.inject({ method: 'GET', url: '/fig-masonry-roundtrip' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /class="rkr-figure rkr-figure-masonry/);
  assert.match(page.body, /--rkr-cols: 3/);
  await assertSampledImagesResolve(app, page.body);
});

test('::figure carousel (overflow): rendered URLs resolve across all pages', async (t) => {
  // Phase 2: matrix=1x2 with 5 distinct ids → 3 pages, the last with
  // 1 empty cell. Distinct ids matter — extractImageIdsAndAlts dedupes
  // before render, so passing the same id 5× collapses to 1 cell. The
  // carousel uses .rkr-carousel-* classes so the existing carousel.js
  // controller picks it up. End-to-end test verifies every page's
  // image URLs resolve via /img/.
  const { app, root } = await setup(t);
  const ids = await ingestN(t, root, 5);
  const post = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'fig-carousel-roundtrip',
      title: 'Figure carousel',
      status: 'published',
      markdown: `::figure{ids="${ids.join(',')}" matrix=1x2 timer=10}\n`
    }
  });
  assert.equal(post.statusCode, 200, post.body);

  const page = await app.inject({ method: 'GET', url: '/fig-carousel-roundtrip' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /class="rkr-figure rkr-figure-carousel rkr-carousel /);
  assert.match(page.body, /data-autoplay="10"/);
  // 3 pages × matrix.cells - empty trailing = 5 cells across all pages.
  const slides = (page.body.match(/<div class="rkr-carousel-slide rkr-figure-page"/g) ?? []).length;
  assert.equal(slides, 3);
  await assertSampledImagesResolve(app, page.body);
});
