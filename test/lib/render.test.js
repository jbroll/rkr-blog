import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import sharp from 'sharp';

import { ingestStream } from '../../src/lib/originals.js';
import { derivativeFilename, derivativePath, renderDerivative } from '../../src/lib/render.js';

function freshSiteRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-render-'));
  fs.mkdirSync(path.join(root, 'sidecars'), { recursive: true });
  fs.mkdirSync(path.join(root, 'originals'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cache', 'img'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function makeJpeg({ width = 200, height = 150, color = { r: 30, g: 60, b: 120 } } = {}) {
  return sharp({
    create: { width, height, channels: 3, background: color }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function ingest(root, bytes) {
  return ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'src.jpg' }
  });
}

const baseArgs = {
  ops: [],
  variant: { w: 100, fit: 'inside' },
  output: { format: 'webp', quality: 85 }
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
