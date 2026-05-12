import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { parseResizeOverrides, resizeAndEncode } from '../../src/lib/ingest-resize.ts';

/** Hand-crafted 2-frame 1×1 animated GIF (GIF89a + NETSCAPE2.0 loop).
 * Sharp's metadata reports pages=2 on this without {animated:true}, so
 * it exercises the predicate ingestStream actually uses. Hand-crafted
 * because sharp can't synthesize an animated GIF from a raw buffer. */
const TINY_ANIMATED_GIF_B64 =
  'R0lGODlhAQABAPAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh' +
  '+QQEMgAAACwAAAAAAQABAAACAkQBACH5BAQyAAAALAAAAAABAAEAAAICTAEAOw==';

function freshTmpDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-resize-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function writeTmp(dir: string, name: string, bytes: Buffer): Promise<string> {
  const p = path.join(dir, name);
  await fs.promises.writeFile(p, bytes);
  return p;
}

test('resizeAndEncode shrinks a large JPEG to maxDim and emits lossy WebP', async (t) => {
  const tmp = freshTmpDir(t);
  // 3500×2500 = 8.75 Mpx — exceeds default maxDim 3200; long edge gets
  // clamped down. Solid colour so the encoder result is deterministic.
  const big = await sharp({
    create: { width: 3500, height: 2500, channels: 3, background: { r: 40, g: 100, b: 160 } }
  })
    .jpeg({ quality: 85 })
    .toBuffer();
  const inputPath = await writeTmp(tmp, 'big.jpg', big);
  const meta = await sharp(inputPath).metadata();

  const result = await resizeAndEncode({ inputPath, meta, tmpDir: tmp });

  assert.equal(result.format, 'webp');
  assert.equal(result.ext, 'webp');
  assert.equal(result.encoding, 'lossy');
  assert.equal(result.reason, 'resized');
  assert.equal(Math.max(result.width, result.height), 3200);
  assert.ok(result.bytes < big.length, 'resized webp should be smaller than the input jpeg');
  assert.equal(result.applied.maxDim, 3200);
  assert.equal(result.applied.scalePct, 100);
  assert.equal(result.applied.webpQuality, 82);
});

test('resizeAndEncode re-encodes a small image without enlarging', async (t) => {
  const tmp = freshTmpDir(t);
  // Long edge 800 < default maxDim 3200; no shrink needed, but still
  // re-encoded to enforce the WebP format policy uniformly.
  const small = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 200, b: 50 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  const inputPath = await writeTmp(tmp, 'small.jpg', small);
  const meta = await sharp(inputPath).metadata();

  const result = await resizeAndEncode({ inputPath, meta, tmpDir: tmp });

  assert.equal(result.format, 'webp');
  assert.equal(result.reason, 'no-shrink-needed');
  assert.equal(result.width, 800);
  assert.equal(result.height, 600);
});

test('resizeAndEncode routes PNG through lossless WebP', async (t) => {
  const tmp = freshTmpDir(t);
  // Use channels:3 (no alpha) so the raw-pixel round-trip comparison
  // isn't muddied by libwebp's alpha-channel optimization (which can
  // strip a constant alpha=1 plane during encode).
  const pngBytes = await sharp({
    create: { width: 128, height: 64, channels: 3, background: { r: 200, g: 30, b: 30 } }
  })
    .png()
    .toBuffer();
  const inputPath = await writeTmp(tmp, 'red.png', pngBytes);
  const meta = await sharp(inputPath).metadata();

  const result = await resizeAndEncode({ inputPath, meta, tmpDir: tmp });

  assert.equal(result.format, 'webp');
  assert.equal(result.encoding, 'lossless');
  assert.equal(result.width, 128);
  assert.equal(result.height, 64);

  // Lossless round-trip: decoded WebP pixels should equal decoded PNG
  // pixels exactly.
  const refPixels = await sharp(pngBytes).raw().toBuffer();
  const outPixels = await sharp(result.outPath).raw().toBuffer();
  assert.equal(Buffer.compare(refPixels, outPixels), 0, 'PNG → lossless WebP must be pixel-exact');
});

test('resizeAndEncode applies scalePct after the maxDim clamp', async (t) => {
  const tmp = freshTmpDir(t);
  // 2000×1500 stays under maxDim=3200, then scalePct=50 halves it.
  const src = await sharp({
    create: { width: 2000, height: 1500, channels: 3, background: { r: 100, g: 100, b: 100 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  const inputPath = await writeTmp(tmp, 'scale.jpg', src);
  const meta = await sharp(inputPath).metadata();

  const result = await resizeAndEncode({
    inputPath,
    meta,
    tmpDir: tmp,
    options: { scalePct: 50 }
  });

  assert.equal(result.reason, 'resized');
  assert.equal(result.width, 1000);
  assert.equal(result.height, 750);
  assert.equal(result.applied.scalePct, 50);
});

test('resizeAndEncode passes animated GIF through unchanged', async (t) => {
  const tmp = freshTmpDir(t);
  const gif = Buffer.from(TINY_ANIMATED_GIF_B64, 'base64');
  const inputPath = await writeTmp(tmp, 'anim.gif', gif);
  const meta = await sharp(inputPath).metadata();
  assert.equal(meta.pages, 2, 'fixture must register as animated');

  const result = await resizeAndEncode({ inputPath, meta, tmpDir: tmp });

  assert.equal(result.format, 'gif');
  assert.equal(result.ext, 'gif');
  assert.equal(result.encoding, 'passthrough');
  assert.equal(result.reason, 'gif-animated');
  const outBytes = fs.readFileSync(result.outPath);
  assert.equal(Buffer.compare(outBytes, gif), 0, 'passthrough must keep bytes identical');
});

test('resizeAndEncode re-encodes a single-frame GIF to lossy WebP', async (t) => {
  const tmp = freshTmpDir(t);
  // Sharp produces a single-page GIF from a raw buffer.
  const staticGif = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 0, g: 0, b: 255 } }
  })
    .gif()
    .toBuffer();
  const inputPath = await writeTmp(tmp, 'static.gif', staticGif);
  const meta = await sharp(inputPath).metadata();
  assert.equal(meta.pages ?? 1, 1, 'fixture must be static');

  const result = await resizeAndEncode({ inputPath, meta, tmpDir: tmp });
  assert.equal(result.format, 'webp');
  assert.equal(result.encoding, 'lossy');
});

test('resizeAndEncode passes SVG through unchanged', async (t) => {
  const tmp = freshTmpDir(t);
  const svg = Buffer.from(
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">' +
      '<rect width="32" height="32" fill="#f0a"/></svg>'
  );
  const inputPath = await writeTmp(tmp, 'icon.svg', svg);
  const meta = await sharp(inputPath).metadata();

  const result = await resizeAndEncode({ inputPath, meta, tmpDir: tmp });
  assert.equal(result.format, 'svg');
  assert.equal(result.ext, 'svg');
  assert.equal(result.encoding, 'passthrough');
  assert.equal(result.reason, 'svg');
  const outBytes = fs.readFileSync(result.outPath);
  assert.equal(Buffer.compare(outBytes, svg), 0, 'SVG passthrough must keep bytes identical');
});

test('resizeAndEncode clamps out-of-range knob values to bounds', async (t) => {
  const tmp = freshTmpDir(t);
  const src = await sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 0, g: 0, b: 0 } }
  })
    .jpeg()
    .toBuffer();
  const inputPath = await writeTmp(tmp, 'tiny.jpg', src);
  const meta = await sharp(inputPath).metadata();

  const result = await resizeAndEncode({
    inputPath,
    meta,
    tmpDir: tmp,
    options: { maxDim: 5, scalePct: 0, webpQuality: 9999 }
  });
  // maxDim min=64, scalePct min=10, webpQuality max=100
  assert.equal(result.applied.maxDim, 64);
  assert.equal(result.applied.scalePct, 10);
  assert.equal(result.applied.webpQuality, 100);
});

test('resizeAndEncode applies defaults when options is undefined', async (t) => {
  const tmp = freshTmpDir(t);
  const src = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } }
  })
    .jpeg()
    .toBuffer();
  const inputPath = await writeTmp(tmp, 'd.jpg', src);
  const meta = await sharp(inputPath).metadata();

  const result = await resizeAndEncode({ inputPath, meta, tmpDir: tmp });
  assert.deepEqual(result.applied, { maxDim: 3200, scalePct: 100, webpQuality: 82 });
});

test('parseResizeOverrides extracts numeric fields and coerces strings', () => {
  assert.equal(parseResizeOverrides(undefined), undefined);
  assert.equal(parseResizeOverrides(null), undefined);
  assert.equal(parseResizeOverrides('not an object'), undefined);
  assert.equal(parseResizeOverrides({}), undefined);
  // No recognized fields → undefined (let defaults win in the helper).
  assert.equal(parseResizeOverrides({ unrelated: 5 }), undefined);

  assert.deepEqual(parseResizeOverrides({ maxDim: 1600 }), { maxDim: 1600 });
  // Strings (from multipart fields) coerce.
  assert.deepEqual(parseResizeOverrides({ maxDim: '1600', scalePct: '75' }), {
    maxDim: 1600,
    scalePct: 75
  });
  // Garbage values get dropped, not propagated.
  assert.deepEqual(parseResizeOverrides({ maxDim: 'banana', webpQuality: 60 }), {
    webpQuality: 60
  });
});
