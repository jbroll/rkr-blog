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

test('imageDimensions: bake-missing fallback handles all op shapes', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload' }
  });
  const sidecar = await sidecarRead(root, r.id);
  assert.ok(sidecar);

  // rotate 180 → dims unchanged.
  sidecar.ops = [{ type: 'rotate', degrees: 180 }];
  await sidecarWrite(root, r.id, sidecar);
  assert.deepEqual(await imageDimensions(root, r.id, sidecar), { width: 800, height: 600 });

  // rotate 270 → swap.
  sidecar.ops = [{ type: 'rotate', degrees: 270 }];
  await sidecarWrite(root, r.id, sidecar);
  assert.deepEqual(await imageDimensions(root, r.id, sidecar), { width: 600, height: 800 });

  // flip → dims unchanged (both axes).
  sidecar.ops = [{ type: 'flip', axis: 'horizontal' }];
  await sidecarWrite(root, r.id, sidecar);
  assert.deepEqual(await imageDimensions(root, r.id, sidecar), { width: 800, height: 600 });

  // resample with only w → height scales proportionally.
  sidecar.ops = [{ type: 'resample', w: 400, fit: 'inside' }];
  await sidecarWrite(root, r.id, sidecar);
  assert.deepEqual(await imageDimensions(root, r.id, sidecar), { width: 400, height: 300 });

  // resample fit=fill → both dims set absolutely.
  sidecar.ops = [{ type: 'resample', w: 100, h: 100, fit: 'fill' }];
  await sidecarWrite(root, r.id, sidecar);
  assert.deepEqual(await imageDimensions(root, r.id, sidecar), { width: 100, height: 100 });

  // resample fit=cover (outside) → max scale; withoutEnlargement caps at 1.
  sidecar.ops = [{ type: 'resample', w: 200, h: 100, fit: 'cover' }];
  await sidecarWrite(root, r.id, sidecar);
  // 800×600 → scale = max(200/800, 100/600) = 0.25 → 200×150.
  assert.deepEqual(await imageDimensions(root, r.id, sidecar), { width: 200, height: 150 });

  // perspective → corner bbox.
  sidecar.ops = [
    {
      type: 'perspective',
      corners: [
        [10, 20],
        [410, 30],
        [420, 320],
        [0, 310]
      ]
    }
  ];
  await sidecarWrite(root, r.id, sidecar);
  assert.deepEqual(await imageDimensions(root, r.id, sidecar), { width: 420, height: 300 });
});
