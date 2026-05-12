import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { runVerify } from '../../src/cli/verify.ts';
import { sha256File } from '../../src/lib/hash.ts';
import { ingestStream, originalPath } from '../../src/lib/originals.ts';
import { write as sidecarWrite } from '../../src/lib/sidecar.ts';
import type { Sidecar } from '../../src/lib/sidecar-types.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-cli-verify-'));
  for (const sub of ['sidecars', 'originals']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function makeJpeg() {
  return sharp({
    create: { width: 80, height: 60, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

test('runVerify reports zero mismatches on a clean tree', async (t) => {
  const root = freshSiteRoot(t);
  await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });

  const result = await runVerify(root);
  assert.equal(result.checked, 1);
  assert.deepEqual(result.mismatches, []);
});

test('runVerify flags hash-mismatch when the original bytes are corrupted', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });

  // Corrupt the file in place. The sidecar still claims the original sha256.
  const filepath = originalPath(root, r.id, r.ext);
  fs.writeFileSync(filepath, Buffer.from('not the same bytes anymore'));

  const result = await runVerify(root);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0]?.id, r.id);
  assert.equal(result.mismatches[0]?.reason, 'hash-mismatch');
});

test('runVerify validates a pre-resize sidecar against s.original (no storedHash)', async (t) => {
  // Pre-feature sidecars (written before ingest-time resize landed) lack
  // source.storedHash, so verify must fall back to comparing against
  // s.original — which equals the on-disk hash because the on-disk bytes
  // ARE the upload bytes in that era. Simulate by hand-writing both.
  const root = freshSiteRoot(t);
  const bytes = await makeJpeg();
  const id = await (async () => {
    const tmp = path.join(root, 'tmp.jpg');
    fs.writeFileSync(tmp, bytes);
    const h = await sha256File(tmp);
    fs.unlinkSync(tmp);
    return h;
  })();
  const dir = path.join(root, 'originals', id.slice(0, 2), id.slice(2, 4));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jpg`), bytes);
  const legacy: Sidecar = {
    version: 1,
    original: id,
    source: { kind: 'upload', originalName: 'legacy.jpg' },
    ops: [],
    outputs: [],
    variants: []
  };
  await sidecarWrite(root, id, legacy);

  const result = await runVerify(root);
  assert.equal(result.checked, 1);
  assert.deepEqual(result.mismatches, []);
});

test('runVerify flags missing-original when the file is gone', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });

  fs.unlinkSync(originalPath(root, r.id, r.ext));

  const result = await runVerify(root);
  assert.equal(result.checked, 0);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0]?.reason, 'missing-original');
});
