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
