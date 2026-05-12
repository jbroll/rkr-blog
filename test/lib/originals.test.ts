import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { ingestStream, originalPath } from '../../src/lib/originals.ts';
import { read as sidecarRead } from '../../src/lib/sidecar.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-orig-'));
  fs.mkdirSync(path.join(root, 'sidecars'), { recursive: true });
  fs.mkdirSync(path.join(root, 'originals'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Persist an ingestResize block to <root>/config/site.json so the
 * next ingestStream call picks it up. Mirrors what /admin/settings
 * writes via writePersistedSiteConfig. */
function writeIngestResizeConfig(
  root: string,
  ingestResize: { maxDim?: number; scalePct?: number; webpQuality?: number }
): void {
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'site.json'), JSON.stringify({ ingestResize }, null, 2));
}

async function makeJpeg({ width = 64, height = 48, color = { r: 30, g: 60, b: 120 } } = {}) {
  return sharp({
    create: { width, height, channels: 3, background: color }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function makePng({
  width = 32,
  height = 32,
  color = { r: 200, g: 30, b: 30, alpha: 1 }
} = {}) {
  return sharp({
    create: { width, height, channels: 4, background: color }
  })
    .png()
    .toBuffer();
}

test('ingestStream writes to sharded path and produces a valid sidecar', async (t) => {
  const root = freshSiteRoot(t);
  const bytes = await makeJpeg();
  const expectedId = crypto.createHash('sha256').update(bytes).digest('hex');

  const result = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'sample.jpg' }
  });

  assert.equal(result.id, expectedId);
  assert.equal(result.bytes, bytes.length);
  assert.equal(result.deduplicated, false);
  // Ingest re-encodes every raster master to WebP (see ingest-resize.ts).
  assert.equal(result.ext, 'webp');

  // Sharded layout: originals/<2>/<2>/<id>.webp (id stays = upload hash;
  // only the on-disk bytes change).
  const expectedPath = originalPath(root, expectedId, 'webp');
  assert.equal(result.path, expectedPath);
  assert.ok(fs.existsSync(expectedPath));

  // Sidecar populated with post-resize metadata + upload provenance.
  const sidecar = await sidecarRead(root, expectedId);
  assert.ok(sidecar);
  assert.equal(sidecar.version, 1);
  assert.equal(sidecar.original, expectedId);
  assert.equal(sidecar.source.kind, 'upload');
  assert.equal(sidecar.source.originalName, 'sample.jpg');
  assert.match(sidecar.source.fetched ?? '', /^\d{4}-\d{2}-\d{2}T/);
  // metadata describes the bytes on disk (post-resize WebP).
  assert.equal(sidecar.metadata.format, 'webp');
  assert.equal(sidecar.metadata.width, 64);
  assert.equal(sidecar.metadata.height, 48);
  // Upload provenance describes the pre-resize bytes.
  assert.equal(sidecar.source.uploadFormat, 'jpeg');
  assert.equal(sidecar.source.uploadWidth, 64);
  assert.equal(sidecar.source.uploadHeight, 48);
  assert.equal(sidecar.source.uploadBytes, bytes.length);
  // 64×48 is under maxDim=3200, so no shrink happened — just re-encode.
  assert.equal(sidecar.source.resize?.reason, 'no-shrink-needed');
  assert.equal(sidecar.source.resize?.encoding, 'lossy');
  assert.deepEqual(sidecar.ops, []);
  assert.ok(Array.isArray(sidecar.outputs) && sidecar.outputs.length > 0);
  assert.ok(Array.isArray(sidecar.variants) && sidecar.variants.length > 0);
});

test('ingestStream dedupes byte-identical re-uploads without rewriting', async (t) => {
  const root = freshSiteRoot(t);
  const bytes = await makeJpeg({ color: { r: 10, g: 200, b: 50 } });

  const first = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'a.jpg' }
  });
  assert.equal(first.deduplicated, false);

  const sizeBefore = fs.statSync(first.path).size;
  const mtimeBefore = fs.statSync(first.path).mtimeMs;

  // Force a different timestamp granularity by waiting briefly.
  await new Promise((r) => setTimeout(r, 20));

  const second = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'different-name.jpg' }
  });
  assert.equal(second.id, first.id);
  assert.equal(second.deduplicated, true);
  assert.equal(second.path, first.path);

  const statAfter = fs.statSync(first.path);
  assert.equal(statAfter.size, sizeBefore);
  assert.equal(statAfter.mtimeMs, mtimeBefore, 'original file must not be rewritten on dedupe');

  // Sidecar must not be overwritten — first source.originalName preserved.
  const sidecar = await sidecarRead(root, first.id);
  assert.ok(sidecar);
  assert.equal(sidecar.source.originalName, 'a.jpg');
});

test('ingestStream re-encodes PNG inputs to lossless WebP', async (t) => {
  const root = freshSiteRoot(t);
  const bytes = await makePng();

  const result = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'red.png' }
  });

  // PNG → lossless WebP. The .png ext is no longer produced by ingest.
  assert.equal(result.ext, 'webp');
  assert.ok(result.path.endsWith('.webp'));
  const sidecar = await sidecarRead(root, result.id);
  assert.ok(sidecar);
  assert.equal(sidecar.metadata.format, 'webp');
  assert.equal(sidecar.source.uploadFormat, 'png');
  assert.equal(sidecar.source.resize?.encoding, 'lossless');
});

test('ingestStream rejects non-image bytes', async (t) => {
  const root = freshSiteRoot(t);
  const bytes = Buffer.from('this is not an image, definitely not');
  await assert.rejects(
    ingestStream({
      stream: Readable.from([bytes]),
      siteRoot: root,
      source: { kind: 'upload' }
    }),
    /not a recognized image/
  );

  // No leftover temp file should remain.
  const tmpDir = path.join(root, 'originals', '.tmp');
  if (fs.existsSync(tmpDir)) {
    assert.deepEqual(fs.readdirSync(tmpDir), []);
  }
});

test('ingestStream rejects oversized images (decompression-bomb defense)', async (t) => {
  const root = freshSiteRoot(t);
  // 15000 × 15000 = 225 Mpx > SHARP_INGEST_PIXEL_LIMIT (200 Mpx).
  // The pre-feature 50 Mpx cap accepted these now (ingest accepts up
  // to 200 Mpx and resizes down), so the fixture has to clear the new
  // ceiling to exercise the rejection path.
  const big = await sharp({
    create: { width: 15000, height: 15000, channels: 3, background: { r: 0, g: 0, b: 0 } }
  })
    .jpeg({ quality: 50 })
    .toBuffer();
  await assert.rejects(
    ingestStream({
      stream: Readable.from([big]),
      siteRoot: root,
      source: { kind: 'upload', originalName: 'huge.jpg' }
    }),
    /(too large|exceeds|recognized image)/
  );
  // No leftover temp file.
  const tmpDir = path.join(root, 'originals', '.tmp');
  if (fs.existsSync(tmpDir)) {
    assert.deepEqual(fs.readdirSync(tmpDir), []);
  }
});

test('ingestStream stores display dimensions for EXIF Orientation=6 (portrait)', async (t) => {
  const root = freshSiteRoot(t);
  // 100×40 landscape buffer with orientation=6 → displayed as 40×100 portrait.
  // Phones save portrait shots this way (encoded sideways, tag rotates them).
  const bytes = await sharp({
    create: { width: 100, height: 40, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 80 })
    .toBuffer();

  const result = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'portrait.jpg' }
  });

  const sidecar = await sidecarRead(root, result.id);
  assert.ok(sidecar);
  assert.equal(sidecar.metadata.width, 40, 'sidecar width should match display orientation');
  assert.equal(sidecar.metadata.height, 100, 'sidecar height should match display orientation');
});

test('ingestStream leaves dimensions untouched for EXIF Orientation=1 (default)', async (t) => {
  const root = freshSiteRoot(t);
  const bytes = await sharp({
    create: { width: 100, height: 40, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .withMetadata({ orientation: 1 })
    .jpeg({ quality: 80 })
    .toBuffer();

  const result = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'landscape.jpg' }
  });

  const sidecar = await sidecarRead(root, result.id);
  assert.ok(sidecar);
  assert.equal(sidecar.metadata.width, 100);
  assert.equal(sidecar.metadata.height, 40);
});

test('ingestStream downsamples a large JPEG to the configured maxDim', async (t) => {
  const root = freshSiteRoot(t);
  // 3500×2500 long edge exceeds default maxDim 3200.
  const bytes = await sharp({
    create: { width: 3500, height: 2500, channels: 3, background: { r: 40, g: 100, b: 160 } }
  })
    .jpeg({ quality: 85 })
    .toBuffer();

  const result = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'large.jpg' }
  });

  assert.equal(result.ext, 'webp');
  const sidecar = await sidecarRead(root, result.id);
  assert.ok(sidecar);
  assert.equal(sidecar.source.uploadFormat, 'jpeg');
  assert.equal(sidecar.source.uploadWidth, 3500);
  assert.equal(sidecar.source.uploadHeight, 2500);
  assert.equal(sidecar.source.resize?.reason, 'resized');
  assert.equal(sidecar.source.resize?.applied, true);
  assert.equal(sidecar.source.resize?.encoding, 'lossy');
  assert.equal(sidecar.metadata.width, 3200);
  assert.equal(sidecar.metadata.height, Math.round((2500 * 3200) / 3500));
  // On-disk file must be smaller than the source upload.
  const onDiskSize = fs.statSync(result.path).size;
  assert.ok(onDiskSize < bytes.length, 'resized webp should beat the source jpeg on bytes');
});

test('ingestStream applies portrait orientation BEFORE the resize clamp', async (t) => {
  const root = freshSiteRoot(t);
  // 4000×3000 encoded as landscape, orientation=6 → displayed portrait
  // (3000×4000). Default maxDim 3200 caps the long edge (now height).
  const bytes = await sharp({
    create: { width: 4000, height: 3000, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 80 })
    .toBuffer();

  const result = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'phone-portrait.jpg' }
  });

  const sidecar = await sidecarRead(root, result.id);
  assert.ok(sidecar);
  // After orientation bake: 3000×4000 portrait. Then maxDim=3200 caps
  // the long edge (height) → final 2400×3200.
  assert.equal(sidecar.metadata.width, 2400);
  assert.equal(sidecar.metadata.height, 3200);
});

test('ingestStream reads ingestResize knobs from site config', async (t) => {
  const root = freshSiteRoot(t);
  writeIngestResizeConfig(root, { maxDim: 800, webpQuality: 60 });
  const bytes = await sharp({
    create: { width: 2000, height: 1500, channels: 3, background: { r: 60, g: 60, b: 60 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();

  const result = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'site-config.jpg' }
  });

  const sidecar = await sidecarRead(root, result.id);
  assert.ok(sidecar);
  assert.equal(sidecar.source.resize?.maxDim, 800);
  assert.equal(sidecar.source.resize?.webpQuality, 60);
  // scalePct wasn't set → falls back to compile-time default (100).
  assert.equal(sidecar.source.resize?.scalePct, 100);
  assert.equal(sidecar.metadata.width, 800);
  assert.equal(sidecar.metadata.height, 600);
});

test('ingestStream falls back to compile-time defaults when site.json is absent', async (t) => {
  const root = freshSiteRoot(t);
  const bytes = await sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 0, g: 0, b: 0 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();

  const result = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'no-config.jpg' }
  });

  const sidecar = await sidecarRead(root, result.id);
  assert.ok(sidecar);
  // DEFAULT_INGEST_RESIZE = { maxDim: 3200, scalePct: 100, webpQuality: 82 }
  assert.equal(sidecar.source.resize?.maxDim, 3200);
  assert.equal(sidecar.source.resize?.scalePct, 100);
  assert.equal(sidecar.source.resize?.webpQuality, 82);
});

test('ingestStream passes animated GIFs through unchanged', async (t) => {
  const root = freshSiteRoot(t);
  // Hand-crafted 2-frame 1×1 animated GIF; sharp metadata sees pages=2.
  const gif = Buffer.from(
    'R0lGODlhAQABAPAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh' +
      '+QQEMgAAACwAAAAAAQABAAACAkQBACH5BAQyAAAALAAAAAABAAEAAAICTAEAOw==',
    'base64'
  );

  const result = await ingestStream({
    stream: Readable.from([gif]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'anim.gif' }
  });

  assert.equal(result.ext, 'gif');
  const onDisk = fs.readFileSync(result.path);
  assert.equal(Buffer.compare(onDisk, gif), 0, 'animated GIF must reach disk unchanged');
  const sidecar = await sidecarRead(root, result.id);
  assert.ok(sidecar);
  assert.equal(sidecar.source.resize?.reason, 'gif-animated');
  assert.equal(sidecar.source.resize?.encoding, 'passthrough');
});

test('ingestStream preserves the first sidecar on dedup even if knobs change', async (t) => {
  const root = freshSiteRoot(t);
  const bytes = await makeJpeg();

  // First ingest with quality=90 in site config.
  writeIngestResizeConfig(root, { webpQuality: 90 });
  const first = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'a.jpg' }
  });
  // Operator changes the knob between uploads. The second ingest is a
  // dedup hit — the first sidecar (and its q=90 record) must stand.
  writeIngestResizeConfig(root, { webpQuality: 30 });
  const second = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'b.jpg' }
  });

  assert.equal(second.deduplicated, true);
  assert.equal(second.id, first.id);
  // Second call's distinct knobs must not overwrite the first sidecar.
  const sidecar = await sidecarRead(root, first.id);
  assert.ok(sidecar);
  assert.equal(sidecar.source.originalName, 'a.jpg');
  assert.equal(sidecar.source.resize?.webpQuality, 90);
});
