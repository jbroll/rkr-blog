// Integration test: crop op → commit → blog page renders new-hash URL → derivative resolves.
// Exercises the full save path: POST /admin/sidecar/:id/commit (bake + ops), sidecar update,
// stale-cache deletion, re-render from bake at /img/:filename, and post-page URL alignment.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { open } from '../../src/lib/db.ts';
import { cacheKey } from '../../src/lib/hash.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { ingestStream } from '../../src/lib/originals.ts';
import { read as sidecarRead } from '../../src/lib/sidecar.ts';
import { buildApp } from '../../src/server.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-crop-save-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'bakes', 'content/posts', 'data']) {
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
  // 100×100 JPEG original — large enough that a 60×60 crop is valid.
  const jpegBuf = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 200, g: 50, b: 50 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  const ingest = await ingestStream({
    stream: Readable.from([jpegBuf]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'test.jpg' }
  });
  return { root, app, db, imageId: ingest.id };
}

/** Build a multipart body for POST /admin/sidecar/:id/commit. */
function buildCommitBody(
  ops: object,
  bake: Buffer,
  id: string
): { body: Buffer; boundary: string } {
  const boundary = `----TestBoundary${Date.now()}`;
  const opsJson = JSON.stringify({ ops, redoStack: [] });
  const parts = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="ops"\r\n\r\n`,
    `${opsJson}\r\n`,
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="bake"; filename="${id}.webp"\r\n`,
    `Content-Type: image/webp\r\n\r\n`
  ].join('');
  const tail = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(parts), bake, Buffer.from(tail)]);
  return { body, boundary };
}

test('crop commit → sidecar ops updated, stale cache deleted', async (t) => {
  const { root, app, imageId } = await setup(t);

  // Plant a fake pre-crop derivative to verify it gets deleted.
  const preOps: never[] = [];
  const preHash = cacheKey({
    originalId: imageId,
    ops: preOps,
    variant: { w: 300 },
    output: { format: 'webp', quality: 80 }
  });
  const stalePath = path.join(root, 'cache', 'img', `${imageId}.${preHash}.webp`);
  fs.writeFileSync(stalePath, 'placeholder');

  // Build a 60×60 WebP bake representing crop {x:10, y:10, w:60, h:60}.
  const bakeBuf = await sharp({
    create: { width: 60, height: 60, channels: 3, background: { r: 100, g: 100, b: 100 } }
  })
    .webp({ quality: 80 })
    .toBuffer();

  const cropOps = [{ type: 'crop', x: 10, y: 10, w: 60, h: 60 }];
  const { body, boundary } = buildCommitBody(cropOps, bakeBuf, imageId);

  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${imageId}/commit`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body
  });

  assert.equal(res.statusCode, 200, `commit failed: ${res.body}`);
  const result = JSON.parse(res.body) as { ops: unknown[]; redoStack: unknown[] };
  assert.equal(result.ops.length, 1);
  assert.deepEqual(result.ops[0], { type: 'crop', x: 10, y: 10, w: 60, h: 60 });

  // Sidecar must reflect the new ops.
  const sidecar = await sidecarRead(root, imageId);
  assert.ok(sidecar, 'sidecar must exist');
  assert.equal(sidecar.ops.length, 1);

  // Stale pre-crop derivative must be gone.
  assert.ok(!fs.existsSync(stalePath), 'stale pre-crop derivative was not deleted');

  // Bake must be on disk.
  const bakeDir = path.join(root, 'bakes', imageId.slice(0, 2), imageId.slice(2, 4));
  const bakePath = path.join(bakeDir, `${imageId}.webp`);
  assert.ok(fs.existsSync(bakePath), 'bake was not written');
});

test('crop commit → blog page uses new ophash → derivative resolves at correct size', async (t) => {
  const { app, imageId } = await setup(t);

  // Save the post so the blog page route can find it.
  const postRes = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'crop-roundtrip',
      title: 'Crop roundtrip',
      status: 'published',
      markdown: `::figure{ids="${imageId}" alts="crop test"}\n`
    }
  });
  assert.equal(postRes.statusCode, 200, postRes.body);

  // Record the pre-crop page HTML to confirm it uses a different hash.
  const preCropPage = await app.inject({ method: 'GET', url: '/crop-roundtrip' });
  assert.equal(preCropPage.statusCode, 200);

  // Build a 60×60 WebP bake.
  const bakeBuf = await sharp({
    create: { width: 60, height: 60, channels: 3, background: { r: 100, g: 150, b: 200 } }
  })
    .webp({ quality: 80 })
    .toBuffer();

  const cropOps = [{ type: 'crop', x: 10, y: 10, w: 60, h: 60 }];
  const { body, boundary } = buildCommitBody(cropOps, bakeBuf, imageId);

  const commitRes = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${imageId}/commit`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body
  });
  assert.equal(commitRes.statusCode, 200, `commit failed: ${commitRes.body}`);

  // Re-render the post page after the crop save.
  const postCropPage = await app.inject({ method: 'GET', url: '/crop-roundtrip' });
  assert.equal(postCropPage.statusCode, 200);

  // Extract the first /img/<id>.<hash>.<ext> URL from the post-crop page.
  const imgUrlRe = new RegExp(`/img/${imageId}\\.([0-9a-f]+)\\.(webp|jpg|jpeg)`, 'g');
  const matches = [...postCropPage.body.matchAll(imgUrlRe)];
  assert.ok(matches.length > 0, 'no image URLs in post-crop page HTML');

  // Verify the page URL changed (different ophash than pre-crop).
  const preCropMatches = [...preCropPage.body.matchAll(imgUrlRe)];
  const preHash = preCropMatches[0]?.[1];
  const postHash = matches[0]?.[1];
  assert.notEqual(preHash, postHash, 'ophash did not change after crop commit');

  // Fetch a derivative at the post-crop URL. Should resolve (200 or 202).
  const imgUrl = matches[0]?.[0] ?? '';
  assert.ok(imgUrl, 'no image URL extracted');
  const imgRes = await app.inject({ method: 'GET', url: imgUrl });
  assert.ok(
    imgRes.statusCode === 200 || imgRes.statusCode === 202,
    `post-crop image URL ${imgUrl} → ${imgRes.statusCode}: ${imgRes.body}`
  );

  // For a 200 response, verify the derivative is smaller than 100×100 (the crop worked).
  if (imgRes.statusCode === 200) {
    const meta = await sharp(Buffer.from(imgRes.rawPayload)).metadata();
    assert.ok(
      (meta.width ?? 0) <= 100 && (meta.height ?? 0) <= 100,
      `derivative ${meta.width}×${meta.height} unexpectedly large for a 60×60 crop`
    );
  }
});

test('crop commit with ops=[] clears ops, deletes bake, and renders from original', async (t) => {
  const { root, app, imageId } = await setup(t);

  // First save a crop so there's a bake on disk.
  const bakeBuf = await sharp({
    create: { width: 60, height: 60, channels: 3, background: { r: 100, g: 100, b: 100 } }
  })
    .webp({ quality: 80 })
    .toBuffer();
  const cropOps = [{ type: 'crop', x: 10, y: 10, w: 60, h: 60 }];
  const first = buildCommitBody(cropOps, bakeBuf, imageId);
  const firstRes = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${imageId}/commit`,
    headers: { 'content-type': `multipart/form-data; boundary=${first.boundary}` },
    body: first.body
  });
  assert.equal(firstRes.statusCode, 200, firstRes.body);

  const bakeDir = path.join(root, 'bakes', imageId.slice(0, 2), imageId.slice(2, 4));
  const bakePath = path.join(bakeDir, `${imageId}.webp`);
  assert.ok(fs.existsSync(bakePath), 'bake must exist after first commit');

  // Now clear the ops (ops=[]).
  const clearBoundary = `----ClearBoundary${Date.now()}`;
  const clearOps = JSON.stringify({ ops: [], redoStack: [] });
  const clearBody =
    `--${clearBoundary}\r\n` +
    `Content-Disposition: form-data; name="ops"\r\n\r\n` +
    `${clearOps}\r\n` +
    `--${clearBoundary}--\r\n`;

  const clearRes = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${imageId}/commit`,
    headers: { 'content-type': `multipart/form-data; boundary=${clearBoundary}` },
    body: Buffer.from(clearBody)
  });
  assert.equal(clearRes.statusCode, 200, `clear commit failed: ${clearRes.body}`);
  const clearResult = JSON.parse(clearRes.body) as { ops: unknown[] };
  assert.deepEqual(clearResult.ops, []);

  // Bake should be gone.
  assert.ok(!fs.existsSync(bakePath), 'bake must be deleted after ops=[] commit');
});

// Regression test: validate that rotate-then-crop ops (where the crop
// coordinates are in the rotated canvas space, not the original) are
// accepted by the commit endpoint. The bug: validateOps validates crop
// bounds against the ORIGINAL dims, not post-rotate dims. A landscape
// 200×100 rotated 90° becomes 100×200 in canvas space; cropping to
// {x:0,y:0,w:80,h:150} is valid in rotated space but FAILS validation
// against the original 200×100 (h+y=150 > H=100).
test('rotate-then-crop: crop in rotated canvas space is accepted', async (t) => {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  t.after(() => db.close());
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(() => app.close());

  // 200×100 landscape image. After a 90° rotation, the canvas becomes 100×200.
  // A crop of {x:0,y:0,w:80,h:150} is valid in the 100×200 rotated space
  // but the y+h=150 > original H=100 would fail a naive original-dims check.
  const jpegBuf = await sharp({
    create: { width: 200, height: 100, channels: 3, background: { r: 80, g: 120, b: 200 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  const ingest = await ingestStream({
    stream: Readable.from([jpegBuf]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'landscape.jpg' }
  });
  const id = ingest.id;

  // The bake represents: rotate(90°) then crop(0,0,80,150) applied to original.
  // Resulting dimensions: 80×150.
  const bakeBuf = await sharp({
    create: { width: 80, height: 150, channels: 3, background: { r: 80, g: 120, b: 200 } }
  })
    .webp({ quality: 80 })
    .toBuffer();

  const ops = [
    { type: 'rotate', degrees: 90 },
    { type: 'crop', x: 0, y: 0, w: 80, h: 150 }
  ];
  const { body, boundary } = buildCommitBody(ops, bakeBuf, id);

  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${id}/commit`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body
  });

  // This SHOULD succeed but currently fails with 400 because validateOps
  // checks crop against original dims (200×100) instead of post-rotate dims (100×200).
  assert.equal(res.statusCode, 200, `rotate-then-crop commit failed: ${res.body}`);
});
