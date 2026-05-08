import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { bakePath, ingestStream } from '../../src/lib/originals.ts';
import {
  derivativeFilename,
  derivativePath,
  type Op,
  renderDerivative
} from '../../src/lib/render.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-render-'));
  fs.mkdirSync(path.join(root, 'sidecars'), { recursive: true });
  fs.mkdirSync(path.join(root, 'originals'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cache', 'img'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function makeJpeg({
  width = 200,
  height = 150,
  color = { r: 30, g: 60, b: 120 }
}: {
  width?: number;
  height?: number;
  color?: { r: number; g: number; b: number };
} = {}) {
  return sharp({
    create: { width, height, channels: 3, background: color }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function ingest(root: string, bytes: Buffer) {
  return ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'src.jpg' }
  });
}

const baseArgs = {
  ops: [] as Op[],
  variant: { w: 100, fit: 'inside' as const },
  output: { format: 'webp' as const, quality: 85 }
};

test('renderDerivative produces deterministic bytes for identical inputs', async (t) => {
  const root1 = freshSiteRoot(t);
  const root2 = freshSiteRoot(t);
  const bytes = await makeJpeg();

  const a = await ingest(root1, bytes);
  const b = await ingest(root2, bytes);
  assert.equal(a.id, b.id);

  const args1 = { ...baseArgs, originalId: a.id, siteRoot: root1 };
  const args2 = { ...baseArgs, originalId: b.id, siteRoot: root2 };

  const r1 = await renderDerivative(args1);
  const r2 = await renderDerivative(args2);

  const h1 = crypto.createHash('sha256').update(fs.readFileSync(r1.path)).digest('hex');
  const h2 = crypto.createHash('sha256').update(fs.readFileSync(r2.path)).digest('hex');

  assert.equal(h1, h2, 'identical inputs must produce identical bytes');
});

test('renderDerivative second call hits the cache (does not invoke Sharp)', async (t) => {
  const root = freshSiteRoot(t);
  const { id } = await ingest(root, await makeJpeg());

  const args = { ...baseArgs, originalId: id, siteRoot: root };
  const first = await renderDerivative(args);
  assert.equal(first.cached, false);

  // Touch the cache file to a known mtime, then re-render. If Sharp ran, the
  // file would be replaced (rename) and mtime would change.
  const fixedTime = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(first.path, fixedTime, fixedTime);
  const mtimeBefore = fs.statSync(first.path).mtimeMs;

  const second = await renderDerivative(args);
  assert.equal(second.cached, true);
  assert.equal(second.path, first.path);
  assert.equal(
    fs.statSync(first.path).mtimeMs,
    mtimeBefore,
    'cache hit must not rewrite the file (Sharp must not be invoked)'
  );
});

test('ophash and filename change when ops change', async (t) => {
  const root = freshSiteRoot(t);
  const { id } = await ingest(root, await makeJpeg({ width: 400, height: 300 }));

  const f1 = derivativeFilename({
    originalId: id,
    ops: [{ type: 'crop', x: 0, y: 0, w: 200, h: 200 }],
    variant: { w: 100 },
    output: { format: 'webp', quality: 85 }
  });
  const f2 = derivativeFilename({
    originalId: id,
    ops: [{ type: 'crop', x: 50, y: 50, w: 200, h: 200 }],
    variant: { w: 100 },
    output: { format: 'webp', quality: 85 }
  });
  assert.notEqual(f1, f2, 'different crops must produce different filenames');

  // And in fact rendering both must produce two distinct cache files.
  const r1 = await renderDerivative({
    originalId: id,
    ops: [{ type: 'crop', x: 0, y: 0, w: 200, h: 200 }],
    variant: { w: 100 },
    output: { format: 'webp', quality: 85 },
    siteRoot: root
  });
  const r2 = await renderDerivative({
    originalId: id,
    ops: [{ type: 'crop', x: 50, y: 50, w: 200, h: 200 }],
    variant: { w: 100 },
    output: { format: 'webp', quality: 85 },
    siteRoot: root
  });
  assert.notEqual(r1.path, r2.path);
  assert.ok(fs.existsSync(r1.path));
  assert.ok(fs.existsSync(r2.path));
});

test('renderDerivative writes under cache/img/ with correct filename pattern', async (t) => {
  const root = freshSiteRoot(t);
  const { id } = await ingest(root, await makeJpeg());

  const args = { ...baseArgs, originalId: id, siteRoot: root };
  const r = await renderDerivative(args);
  assert.equal(r.path, derivativePath(root, args));
  assert.ok(r.path.startsWith(path.join(root, 'cache', 'img')));
  assert.match(path.basename(r.path), new RegExp(`^${id}\\.[0-9a-f]{12}\\.webp$`));
});

test('renderDerivative throws when sidecar is missing', async (t) => {
  const root = freshSiteRoot(t);
  const fakeId = 'a'.repeat(64);
  await assert.rejects(
    renderDerivative({ ...baseArgs, originalId: fakeId, siteRoot: root }),
    /no sidecar/
  );
});

test('renderDerivative cleans up its temp file on failure', async (t) => {
  const root = freshSiteRoot(t);
  const { id } = await ingest(root, await makeJpeg());
  // Crop region beyond the image — Sharp's extract will error.
  await assert.rejects(
    renderDerivative({
      originalId: id,
      ops: [{ type: 'crop', x: 0, y: 0, w: 100000, h: 100000 }],
      variant: { w: 100 },
      output: { format: 'webp', quality: 85 },
      siteRoot: root
    })
  );

  const cacheDir = path.join(root, 'cache', 'img');
  const leftovers = fs.existsSync(cacheDir)
    ? fs.readdirSync(cacheDir).filter((f) => f.endsWith('.tmp'))
    : [];
  assert.deepEqual(leftovers, [], 'no .tmp file should be left behind');
});

// ---- rotate / flip / resample end-to-end ------------------------------

test('renderDerivative honours rotate (90° swaps width/height)', async (t) => {
  const root = freshSiteRoot(t);
  // 200x100 source rotated 90° → 100x200 derivative.
  const r = await ingest(root, await makeJpeg({ width: 200, height: 100 }));
  const result = await renderDerivative({
    ...baseArgs,
    originalId: r.id,
    ops: [{ type: 'rotate', degrees: 90 }],
    variant: {}, // skip the resize so dims match the rotated source exactly
    siteRoot: root
  });
  const meta = await sharp(result.path).metadata();
  assert.equal(meta.width, 100);
  assert.equal(meta.height, 200);
});

test('renderDerivative honours flip vertical and flip horizontal', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingest(root, await makeJpeg({ width: 100, height: 100 }));

  const horizontal = await renderDerivative({
    ...baseArgs,
    originalId: r.id,
    ops: [{ type: 'flip', axis: 'horizontal' }],
    siteRoot: root
  });
  const vertical = await renderDerivative({
    ...baseArgs,
    originalId: r.id,
    ops: [{ type: 'flip', axis: 'vertical' }],
    siteRoot: root
  });
  // Different ops → different cacheKeys → different on-disk files.
  assert.notEqual(horizontal.path, vertical.path);
  // Both succeed — solid-color source so we can't usefully compare
  // pixels, but file existence + non-zero bytes confirms sharp ran.
  assert.ok(horizontal.bytes > 0 && vertical.bytes > 0);
});

test('renderDerivative honours resample with explicit dimensions', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingest(root, await makeJpeg({ width: 800, height: 600 }));
  const result = await renderDerivative({
    ...baseArgs,
    originalId: r.id,
    ops: [{ type: 'resample', w: 200, fit: 'inside' }],
    variant: {},
    siteRoot: root
  });
  const meta = await sharp(result.path).metadata();
  assert.equal(meta.width, 200);
  assert.equal(meta.height, 150); // aspect preserved by 'inside' fit
});

test('renderDerivative auto-applies EXIF Orientation=6 (encoded 100×40 → display 40×100)', async (t) => {
  const root = freshSiteRoot(t);
  // Phone-portrait pattern: encoded landscape with orientation=6 means
  // "rotate 90° CW for display." Without auto-rotate the pixel buffer
  // emerges sideways; with auto-rotate the derivative reflects display.
  const bytes = await sharp({
    create: { width: 100, height: 40, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 80 })
    .toBuffer();

  const r = await ingest(root, bytes);
  const result = await renderDerivative({
    ...baseArgs,
    originalId: r.id,
    ops: [],
    variant: {}, // skip resize so we can compare against the post-rotation source dims
    siteRoot: root
  });

  const meta = await sharp(result.path).metadata();
  assert.equal(meta.width, 40, 'rendered width should match display orientation');
  assert.equal(meta.height, 100, 'rendered height should match display orientation');
  // Sharp strips the orientation tag when .rotate() runs; the output should
  // not need a second rotation client-side.
  assert.ok(
    !meta.orientation || meta.orientation === 1,
    `rendered orientation should be normalized, got ${meta.orientation}`
  );
});

test('renderDerivative composes crop + rotate + flip + resample in order', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingest(root, await makeJpeg({ width: 800, height: 600 }));
  // crop to 400x400, rotate 90 (→400x400 still), flip horizontal,
  // resample to 100 wide. Final: 100x100.
  const result = await renderDerivative({
    ...baseArgs,
    originalId: r.id,
    ops: [
      { type: 'crop', x: 100, y: 100, w: 400, h: 400 },
      { type: 'rotate', degrees: 90 },
      { type: 'flip', axis: 'horizontal' },
      { type: 'resample', w: 100, fit: 'inside' }
    ],
    variant: {},
    siteRoot: root
  });
  const meta = await sharp(result.path).metadata();
  assert.equal(meta.width, 100);
  assert.equal(meta.height, 100);
});

// ---- bake-source preference -------------------------------------------
// When bakes/<id>.webp is present, renderDerivative reads it as the
// source and skips applyOp (the bake is already post-ops). This is how
// the editor takes sharp's op-application out of the per-request hot
// path: the client did the work in a canvas, server just downscales /
// re-encodes for variants.

async function makeWebp({
  width,
  height,
  color
}: {
  width: number;
  height: number;
  color: { r: number; g: number; b: number };
}): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .webp({ quality: 90 })
    .toBuffer();
}

async function plantBake(root: string, id: string, bytes: Buffer): Promise<void> {
  const p = bakePath(root, id);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, bytes);
}

test('renderDerivative reads from bakes/<id>.webp when present (skips applyOp)', async (t) => {
  // The original is solid blue 800x600. Plant a bake of solid red at
  // 200x200. With ops=[crop big region of original] but a bake on
  // disk, the renderer should produce red pixels (from the bake) at
  // the variant size, not blue (from the original + crop).
  const root = freshSiteRoot(t);
  const r = await ingest(
    root,
    await makeJpeg({ width: 800, height: 600, color: { r: 0, g: 0, b: 200 } })
  );
  await plantBake(
    root,
    r.id,
    await makeWebp({ width: 200, height: 200, color: { r: 200, g: 0, b: 0 } })
  );

  const result = await renderDerivative({
    ...baseArgs,
    originalId: r.id,
    // Ops would have produced a blue derivative. With the bake taking
    // over, ops are ignored — output is red, sized 100×100 by variant.
    ops: [{ type: 'crop', x: 0, y: 0, w: 400, h: 400 }],
    variant: { w: 100, fit: 'inside' },
    siteRoot: root
  });

  const buf = await fs.promises.readFile(result.path);
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 100);
  assert.equal(info.height, 100);
  // The first pixel should be predominantly red (bake), not blue (original).
  // libvips re-encoding of a solid-color WebP can shift the channel by
  // a few units, so just assert the dominant channel is red.
  const r0 = data[0] ?? 0;
  const g0 = data[1] ?? 0;
  const b0 = data[2] ?? 0;
  assert.ok(
    r0 > g0 + 50 && r0 > b0 + 50,
    `expected red-dominant pixel, got rgb(${r0},${g0},${b0})`
  );
});

test('renderDerivative falls back to original + applyOp when bake is absent', async (t) => {
  // Same setup as above, but no bake on disk → ops should apply normally.
  const root = freshSiteRoot(t);
  const r = await ingest(
    root,
    await makeJpeg({ width: 800, height: 600, color: { r: 0, g: 0, b: 200 } })
  );
  // Sanity: confirm bake is absent before the call.
  assert.equal(fs.existsSync(bakePath(root, r.id)), false);

  const result = await renderDerivative({
    ...baseArgs,
    originalId: r.id,
    ops: [{ type: 'crop', x: 0, y: 0, w: 400, h: 400 }],
    variant: { w: 100, fit: 'inside' },
    siteRoot: root
  });

  const buf = await fs.promises.readFile(result.path);
  const { data } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  // Without the bake, output is sourced from the blue original.
  const r0 = data[0] ?? 0;
  const g0 = data[1] ?? 0;
  const b0 = data[2] ?? 0;
  assert.ok(
    b0 > r0 + 50 && b0 > g0 + 50,
    `expected blue-dominant pixel, got rgb(${r0},${g0},${b0})`
  );
});

test('renderDerivative throws on perspective op when bake is absent', async (t) => {
  // The architecture relies on the bake being present whenever ops
  // contains 'perspective' — sharp can't apply a homography. If a
  // render request slips through without the bake (e.g. /bake POST
  // failed during Save), the renderer must refuse rather than silently
  // produce a derivative that ignores the perspective op.
  const root = freshSiteRoot(t);
  const r = await ingest(root, await makeJpeg({ width: 200, height: 200 }));
  // Manually plant a perspective op in the sidecar (the validateOps
  // server-side path also accepts this; here we go direct so the
  // render unit doesn't depend on the route).
  const sidecarPath = path.join(root, 'sidecars', `${r.id}.json`);
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as {
    ops: unknown[];
    [k: string]: unknown;
  };
  sidecar.ops = [
    {
      type: 'perspective',
      corners: [
        [0, 0],
        [200, 0],
        [200, 200],
        [0, 200]
      ]
    }
  ];
  fs.writeFileSync(sidecarPath, JSON.stringify(sidecar));
  // No bake on disk for this id → render falls into the original +
  // applyOp path → applyOp's switch hits the default branch.
  assert.equal(fs.existsSync(bakePath(root, r.id)), false);

  await assert.rejects(
    renderDerivative({
      originalId: r.id,
      ops: sidecar.ops as unknown as Op[],
      variant: { w: 100, fit: 'inside' },
      output: { format: 'webp', quality: 85 },
      siteRoot: root
    }),
    /perspective op requires a bake/
  );
});
