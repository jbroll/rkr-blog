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

import { ingestStream } from '../../src/lib/originals.ts';
import { renderDerivative } from '../../src/lib/render.ts';

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
