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
  assert.equal(result.ext, 'jpg');

  // Sharded layout: originals/<2>/<2>/<id>.jpg
  const expectedPath = originalPath(root, expectedId, 'jpg');
  assert.equal(result.path, expectedPath);
  assert.ok(fs.existsSync(expectedPath));

  // Bytes on disk match what was streamed in.
  const onDisk = fs.readFileSync(expectedPath);
  assert.deepEqual(onDisk, bytes);

  // Sidecar populated with metadata + provenance.
  const sidecar = await sidecarRead(root, expectedId);
  assert.ok(sidecar);
  assert.equal(sidecar.version, 1);
  assert.equal(sidecar.original, expectedId);
  assert.equal(sidecar.source.kind, 'upload');
  assert.equal(sidecar.source.originalName, 'sample.jpg');
  assert.match(sidecar.source.fetched ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(sidecar.metadata.format, 'jpeg');
  assert.equal(sidecar.metadata.width, 64);
  assert.equal(sidecar.metadata.height, 48);
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

test('ingestStream handles PNG (alpha channel) with the right extension', async (t) => {
  const root = freshSiteRoot(t);
  const bytes = await makePng();

  const result = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'red.png' }
  });

  assert.equal(result.ext, 'png');
  assert.ok(result.path.endsWith('.png'));
  const sidecar = await sidecarRead(root, result.id);
  assert.ok(sidecar);
  assert.equal(sidecar.metadata.format, 'png');
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
  // 8000 x 8000 = 64 Mpx > 50 Mpx cap. Sharp's limitInputPixels throws
  // when the metadata pipeline tries to decode pixel-count guards.
  const big = await sharp({
    create: { width: 8000, height: 8000, channels: 3, background: { r: 0, g: 0, b: 0 } }
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
