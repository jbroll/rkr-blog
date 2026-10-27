// Cover the less-common render.ts switch arms: rotate op, JPEG output, PNG
// output, no-op variant. The Step 3 render.test.ts covered cropping +
// resampling + WebP; this file rounds out the remaining branches.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { open } from '../../src/lib/db.ts';
import { imageSourceById } from '../../src/lib/image-map-fs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { ingestStream } from '../../src/lib/originals.ts';
import { renderDerivative } from '../../src/lib/render.ts';
import { read as sidecarRead, write as sidecarWrite } from '../../src/lib/sidecar.ts';
import type { WidgetCtx } from '../../src/lib/widgets.ts';
import { buildApp } from '../../src/server.ts';
import figure from '../../src/widgets/figure.ts';

const TWO_FRAME_GIF = path.join(import.meta.dirname, '../fixtures/images/two-frame.gif');

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-render-formats-'));
  for (const sub of ['sidecars', 'originals', 'cache/img']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function makeJpeg() {
  return sharp({
    create: { width: 200, height: 150, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function ingest(root: string) {
  return ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });
}

test('renderDerivative: rotate op runs and produces output', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingest(root);
  const result = await renderDerivative({
    originalId: r.id,
    ops: [{ type: 'rotate', degrees: 90 }],
    variant: { w: 100 },
    output: { format: 'webp', quality: 85 },
    siteRoot: root
  });
  assert.equal(result.cached, false);
  assert.ok(fs.statSync(result.path).size > 0);
});

test('renderDerivative: JPEG output produces a JPEG file', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingest(root);
  const result = await renderDerivative({
    originalId: r.id,
    ops: [],
    variant: { w: 100 },
    output: { format: 'jpeg', quality: 80 },
    siteRoot: root
  });
  // JPEG SOI marker.
  const head = fs.readFileSync(result.path).subarray(0, 2);
  assert.equal(head[0], 0xff);
  assert.equal(head[1], 0xd8);
});

test('renderDerivative: PNG output produces a PNG file', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingest(root);
  const result = await renderDerivative({
    originalId: r.id,
    ops: [],
    variant: { w: 100 },
    output: { format: 'png' },
    siteRoot: root
  });
  // PNG signature.
  const head = fs.readFileSync(result.path).subarray(0, 8);
  assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('renderDerivative: variant with no w/h is a no-op (passes through)', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingest(root);
  const result = await renderDerivative({
    originalId: r.id,
    ops: [],
    variant: {}, // no w, no h
    output: { format: 'webp', quality: 85 },
    siteRoot: root
  });
  assert.ok(fs.statSync(result.path).size > 0);
});

test('renderDerivative: unknown op type throws', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingest(root);
  await assert.rejects(
    renderDerivative({
      originalId: r.id,
      ops: [{ type: 'unknown-op' } as never],
      variant: { w: 100 },
      output: { format: 'webp', quality: 85 },
      siteRoot: root
    }),
    /unknown op type/
  );
});

test('renderDerivative: unknown output format throws', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingest(root);
  await assert.rejects(
    renderDerivative({
      originalId: r.id,
      ops: [],
      variant: { w: 100 },
      output: { format: 'gif' as never, quality: 80 },
      siteRoot: root
    }),
    /unknown output format/
  );
});

async function ingestGif(root: string) {
  return ingestStream({
    stream: fs.createReadStream(TWO_FRAME_GIF),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'portrait.gif' }
  });
}

async function figureHtml(root: string, id: string): Promise<string> {
  const src = await imageSourceById(root, id);
  assert.ok(src);
  const ctx = { images: new Map([[id, src]]), videos: new Map() } as unknown as WidgetCtx;
  return figure.render(
    { type: 'leafDirective', name: 'figure', attributes: { ids: id }, children: [] },
    ctx
  );
}

async function appFor(t: TestContext, root: string) {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(() => app.close());
  return app;
}

test('animated GIF: every image URL the figure widget emits serves more than one frame', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestGif(root);
  const html = await figureHtml(root, r.id);
  const urls = [...new Set(html.match(/\/img\/[^\s"]+/g) ?? [])];
  assert.ok(urls.length > 0, html);

  const app = await appFor(t, root);
  for (const url of urls) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, url);
    const meta = await sharp(res.rawPayload, { animated: true }).metadata();
    assert.ok((meta.pages ?? 1) > 1, `${url} served ${meta.format} with ${meta.pages ?? 1} frame`);
  }
});

test('animated GIF: figure emits one sized <img> and a lightbox link to the original', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestGif(root);
  const html = await figureHtml(root, r.id);
  const url = `/img/${r.id}.gif`;
  assert.match(html, new RegExp(`<img src="${url}" width="32" height="24" `));
  assert.match(html, new RegExp(`<a href="${url}" data-pswp-width="32" data-pswp-height="24"`));
  assert.doesNotMatch(html, /<source/);
});

test('animated GIF: first request copies the original into cache/img for the front proxy', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestGif(root);
  const app = await appFor(t, root);
  const res = await app.inject({ method: 'GET', url: `/img/${r.id}.gif` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/gif');
  const cached = path.join(root, 'cache', 'img', `${r.id}.gif`);
  assert.deepEqual(fs.readFileSync(cached), fs.readFileSync(r.path));
});

test('animated GIF: an edited GIF falls back to derivatives and its .gif URL is 404', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestGif(root);
  const sidecar = await sidecarRead(root, r.id);
  assert.ok(sidecar);
  sidecar.ops = [{ type: 'flip', axis: 'horizontal' }];
  await sidecarWrite(root, r.id, sidecar);
  assert.match(await figureHtml(root, r.id), /<source type="image\/webp"/);
  const app = await appFor(t, root);
  const res = await app.inject({ method: 'GET', url: `/img/${r.id}.gif` });
  assert.equal(res.statusCode, 404);
});

test('animated GIF: a .gif URL for a still image or unknown id is 404', async (t) => {
  const root = freshSiteRoot(t);
  const still = await ingest(root);
  const app = await appFor(t, root);
  for (const id of [still.id, 'f'.repeat(64)]) {
    const res = await app.inject({ method: 'GET', url: `/img/${id}.gif` });
    assert.equal(res.statusCode, 404, id);
  }
  assert.deepEqual(fs.readdirSync(path.join(root, 'cache', 'img')), []);
});

test('animated GIF: a failed copy leaves no tmp file in cache/img', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestGif(root);
  const app = await appFor(t, root);
  t.mock.method(fs.promises, 'rename', async () => {
    throw new Error('disk full');
  });
  const res = await app.inject({ method: 'GET', url: `/img/${r.id}.gif` });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(fs.readdirSync(path.join(root, 'cache', 'img')), []);
});
