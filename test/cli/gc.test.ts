import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { runGc } from '../../src/cli/gc.ts';
import { runRender } from '../../src/cli/render.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { ingestStream } from '../../src/lib/originals.ts';
import { type DerivativeArgs, derivativeFilename, derivativePath } from '../../src/lib/render.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-cli-gc-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  db.close();
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

test('runGc deletes orphan cache files; idempotent on second run', async (t) => {
  const root = freshSiteRoot(t);

  const r = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });

  // Render valid derivatives.
  await runRender(root, { concurrency: 2 });
  const cacheDir = path.join(root, 'cache', 'img');
  const validCount = fs.readdirSync(cacheDir).length;
  assert.ok(validCount > 0);

  // Drop in some bogus files: an orphan with a wrong ophash, and a stale .tmp.
  const orphan = `${r.id}.0123456789ab.webp`;
  fs.writeFileSync(path.join(cacheDir, orphan), Buffer.alloc(8));
  const staleTmp = path.join(cacheDir, `${r.id}.deadbeef0001.webp.aabbccdd.tmp`);
  fs.writeFileSync(staleTmp, Buffer.alloc(0));

  const first = await runGc(root, { tmpMinAgeMs: 0 });
  assert.equal(first.deleted, 2, 'orphan + stale .tmp removed');
  assert.equal(first.kept, validCount, 'all valid derivatives preserved');
  assert.equal(fs.existsSync(path.join(cacheDir, orphan)), false);
  assert.equal(fs.existsSync(staleTmp), false);

  const second = await runGc(root, { tmpMinAgeMs: 0 });
  assert.equal(second.deleted, 0, 'second run is a no-op');
  assert.equal(second.kept, validCount);
});

test('runGc on an empty cache directory returns zero counts', async (t) => {
  const root = freshSiteRoot(t);
  const result = await runGc(root);
  assert.deepEqual(result, { deleted: 0, kept: 0 });
});

test('runGc sweeps originals/.tmp leftovers (crashed ingest)', async (t) => {
  const root = freshSiteRoot(t);
  const tmpDir = path.join(root, 'originals', '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'ingest-deadbeef.bin'), Buffer.alloc(4));
  fs.writeFileSync(path.join(tmpDir, 'ingest-feedface.bin'), Buffer.alloc(4));

  const result = await runGc(root, { tmpMinAgeMs: 0 });
  assert.equal(result.deleted, 2, 'both ingest leftovers removed');
  assert.deepEqual(fs.readdirSync(tmpDir), [], 'tmp dir empty after sweep');
});

test('runGc sweeps *.tmp recursively under bakes/ and sidecars/', async (t) => {
  const root = freshSiteRoot(t);
  // bakes/ uses 2/2-prefix sharding: bakes/aa/bb/<id>.webp(.tmp).
  const bakeDir = path.join(root, 'bakes', 'aa', 'bb');
  fs.mkdirSync(bakeDir, { recursive: true });
  fs.writeFileSync(path.join(bakeDir, 'abc123.webp'), Buffer.alloc(4)); // not .tmp; preserved
  fs.writeFileSync(path.join(bakeDir, 'abc123.webp.crash.tmp'), Buffer.alloc(4));
  // sidecars/ is flat.
  const sidecarDir = path.join(root, 'sidecars');
  fs.writeFileSync(path.join(sidecarDir, 'pending.json.tmp'), Buffer.alloc(4));

  const result = await runGc(root, { tmpMinAgeMs: 0 });
  assert.equal(result.deleted, 2, 'two .tmp files removed across bakes + sidecars');
  assert.equal(fs.existsSync(path.join(bakeDir, 'abc123.webp')), true, '.webp preserved');
  assert.equal(fs.existsSync(path.join(bakeDir, 'abc123.webp.crash.tmp')), false);
  assert.equal(fs.existsSync(path.join(sidecarDir, 'pending.json.tmp')), false);
});

test('runGc preserves derivatives produced by render() (round-trip)', async (t) => {
  const root = freshSiteRoot(t);

  const r = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });

  await runRender(root, { concurrency: 2 });

  const args: DerivativeArgs = {
    originalId: r.id,
    ops: r.sidecar.ops as DerivativeArgs['ops'],
    variant: r.sidecar.variants[0] as DerivativeArgs['variant'],
    output: r.sidecar.outputs[0] as DerivativeArgs['output']
  };
  const expectedFile = derivativePath(root, args);
  assert.ok(fs.existsSync(expectedFile));

  await runGc(root);
  assert.ok(
    fs.existsSync(expectedFile),
    `gc must preserve declared derivative ${derivativeFilename(args)}`
  );
});
