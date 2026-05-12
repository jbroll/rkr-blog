// Unit coverage for widget-helpers.imageDimensions: the function
// drives PhotoSwipe data-pswp-width/height + the cell-aspect CSS
// var, so getting it wrong on bake-missing edited images shows up
// as a stretched lightbox view (reporter: 3rd image in
// /new-newest's figure).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { bakePath, ingestStream } from '../../src/lib/originals.ts';
import { read as sidecarRead, write as sidecarWrite } from '../../src/lib/sidecar.ts';
import type { SidecarOp } from '../../src/lib/sidecar-types.ts';
import { imageDimensions } from '../../src/lib/widget-helpers.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-dims-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'bakes', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function makeJpeg(w: number, h: number): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 50, g: 100, b: 200 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

test('imageDimensions: no ops → original on-disk dims', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload' }
  });
  const sidecar = await sidecarRead(root, r.id);
  assert.ok(sidecar);
  const dims = await imageDimensions(root, r.id, sidecar);
  assert.deepEqual(dims, { width: 800, height: 600 });
});

test('imageDimensions: ops + bake present → bake dims (post-ops)', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload' }
  });
  // Simulate editor having committed a crop: sidecar has ops, bake
  // is on disk with post-ops pixels.
  const sidecar = await sidecarRead(root, r.id);
  assert.ok(sidecar);
  sidecar.ops = [{ type: 'crop', x: 0, y: 0, w: 400, h: 200 }];
  await sidecarWrite(root, r.id, sidecar);
  const bakeBytes = await sharp({
    create: { width: 400, height: 200, channels: 3, background: { r: 0, g: 0, b: 0 } }
  })
    .webp()
    .toBuffer();
  const bp = bakePath(root, r.id);
  fs.mkdirSync(path.dirname(bp), { recursive: true });
  fs.writeFileSync(bp, bakeBytes);

  const dims = await imageDimensions(root, r.id, sidecar);
  assert.deepEqual(dims, { width: 400, height: 200 });
});

test('imageDimensions: ops + bake MISSING → original dims with ops applied', async (t) => {
  // The reporter's scenario: pre-/commit-migration sidecar carries
  // ops, no bake on disk. render.ts applies ops live against the
  // original; imageDimensions has to match that so the lightbox
  // (data-pswp-width/height) isn't stretched against a mismatched
  // aspect.
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload' }
  });
  const sidecar = await sidecarRead(root, r.id);
  assert.ok(sidecar);
  sidecar.ops = [{ type: 'crop', x: 0, y: 0, w: 800, h: 200 }];
  await sidecarWrite(root, r.id, sidecar);
  // No bake written. imageDimensions must compute 800×200 (crop
  // applied to the original's 800×600), not 800×600.

  const dims = await imageDimensions(root, r.id, sidecar);
  assert.deepEqual(dims, { width: 800, height: 200 });
});

test('imageDimensions: rotate 90° on bake-missing fallback swaps dims', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload' }
  });
  const sidecar = await sidecarRead(root, r.id);
  assert.ok(sidecar);
  sidecar.ops = [{ type: 'rotate', degrees: 90 }];
  await sidecarWrite(root, r.id, sidecar);

  const dims = await imageDimensions(root, r.id, sidecar);
  assert.deepEqual(dims, { width: 600, height: 800 });
});

test('imageDimensions: resample fit=inside on bake-missing fallback clamps', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg(4000, 3000)]),
    siteRoot: root,
    source: { kind: 'upload' }
  });
  const sidecar = await sidecarRead(root, r.id);
  assert.ok(sidecar);
  sidecar.ops = [{ type: 'resample', w: 800, h: 800, fit: 'inside' }];
  await sidecarWrite(root, r.id, sidecar);

  // 4000×3000 fit-inside 800×800 (post-resize on-disk is already
  // resized to 3200 long edge; resampling further yields 800×600).
  const dims = await imageDimensions(root, r.id, sidecar);
  assert.equal(dims.width, 800);
  assert.equal(dims.height, 600);
});

/** Spin up a fresh siteRoot + ingest a JPEG of (w, h), return the
 * sidecar pre-loaded so the caller can set ops and call imageDimensions. */
async function freshOps(
  t: TestContext,
  w: number,
  h: number,
  ops: SidecarOp[]
): Promise<{ width: number; height: number }> {
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg(w, h)]),
    siteRoot: root,
    source: { kind: 'upload' }
  });
  const sidecar = await sidecarRead(root, r.id);
  if (!sidecar) throw new Error('sidecar missing');
  sidecar.ops = ops;
  await sidecarWrite(root, r.id, sidecar);
  return imageDimensions(root, r.id, sidecar);
}

test('imageDimensions: bake-missing fallback — rotate 180 keeps dims', async (t) => {
  assert.deepEqual(await freshOps(t, 800, 600, [{ type: 'rotate', degrees: 180 }]), {
    width: 800,
    height: 600
  });
});

test('imageDimensions: bake-missing fallback — rotate 270 swaps dims', async (t) => {
  assert.deepEqual(await freshOps(t, 800, 600, [{ type: 'rotate', degrees: 270 }]), {
    width: 600,
    height: 800
  });
});

test('imageDimensions: bake-missing fallback — flip keeps dims', async (t) => {
  assert.deepEqual(await freshOps(t, 800, 600, [{ type: 'flip', axis: 'horizontal' }]), {
    width: 800,
    height: 600
  });
});

test('imageDimensions: bake-missing fallback — resample with only w scales proportionally', async (t) => {
  assert.deepEqual(await freshOps(t, 800, 600, [{ type: 'resample', w: 400, fit: 'inside' }]), {
    width: 400,
    height: 300
  });
});

test('imageDimensions: bake-missing fallback — resample fit=fill sets dims absolutely', async (t) => {
  assert.deepEqual(
    await freshOps(t, 800, 600, [{ type: 'resample', w: 100, h: 100, fit: 'fill' }]),
    { width: 100, height: 100 }
  );
});

test('imageDimensions: bake-missing self-heals (creates the bake on disk)', async (t) => {
  // The whole point of ensureBake is that the bake stops being
  // missing after the first request. Subsequent requests read it
  // directly without re-running sharp.
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload' }
  });
  const sidecar = await sidecarRead(root, r.id);
  assert.ok(sidecar);
  sidecar.ops = [{ type: 'crop', x: 0, y: 0, w: 400, h: 200 }];
  await sidecarWrite(root, r.id, sidecar);
  assert.equal(fs.existsSync(bakePath(root, r.id)), false, 'bake should start missing');

  await imageDimensions(root, r.id, sidecar);
  assert.equal(fs.existsSync(bakePath(root, r.id)), true, 'bake should exist after first call');
  const meta = await sharp(bakePath(root, r.id)).metadata();
  assert.equal(meta.width, 400);
  assert.equal(meta.height, 200);
});

test('imageDimensions: perspective op with no bake → pure-JS resampler recreates it', async (t) => {
  // sharp/libvips has no homography operator, so the recreate path
  // detours through src/lib/perspective-resample.ts (raw RGBA →
  // inverse-homography sample per pixel → bilinear). The output
  // dims match perspectiveOutputSize on the corner quad — average
  // of top/bottom edges for width, average of left/right for height.
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload' }
  });
  const sidecar = await sidecarRead(root, r.id);
  assert.ok(sidecar);
  sidecar.ops = [
    {
      type: 'perspective',
      corners: [
        [10, 20], // tl
        [410, 30], // tr — top edge ≈ 400
        [420, 320], // br — bottom edge ≈ 412
        [0, 310] // bl — left ≈ 290, right ≈ 290
      ]
    }
  ];
  await sidecarWrite(root, r.id, sidecar);
  const dims = await imageDimensions(root, r.id, sidecar);
  // perspectiveOutputSize: width = avg(top, bottom edge lengths),
  // height = avg(left, right edge lengths). With these corners the
  // sqrt distances round to width=410, height=290.
  assert.equal(dims.width, 410);
  assert.equal(dims.height, 290);
  // And the bake exists, so a subsequent call reads from it directly.
  assert.equal(fs.existsSync(bakePath(root, r.id)), true);
});

test('imageDimensions: throws when a perspective op has malformed corners', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload' }
  });
  const sidecar = await sidecarRead(root, r.id);
  assert.ok(sidecar);
  sidecar.ops = [{ type: 'perspective', corners: 'not-an-array' }];
  await sidecarWrite(root, r.id, sidecar);
  await assert.rejects(() => imageDimensions(root, r.id, sidecar), /malformed perspective/);
});
