// Cover the *default-exported* CLI handlers (the ones bin/site-admin invokes),
// not just their runX testable cores. These default handlers parse argv,
// resolve $SITE_ROOT via paths(), and write to console.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { ingestStream, originalPath } from '../../src/lib/originals.ts';

// All default exports use paths() which reads SITE_ROOT from process.env.
// Each test sets it pointing at a fresh temp dir, then restores afterward.
function withSiteRoot(t: TestContext): { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-cli-default-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  const prev = process.env.SITE_ROOT;
  process.env.SITE_ROOT = root;
  t.after(() => {
    if (prev === undefined) delete process.env.SITE_ROOT;
    else process.env.SITE_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root };
}

async function makeJpeg() {
  return sharp({
    create: { width: 80, height: 60, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

test('render default export: parses --force --concurrency and runs end-to-end', async (t) => {
  const { root } = withSiteRoot(t);
  await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });

  const renderCmd = (await import('../../src/cli/render.ts')).default;
  await renderCmd(['--concurrency', '1']);
  await renderCmd(['--force', '--concurrency', '1']);

  // Verify cache files exist.
  const cacheDir = path.join(root, 'cache', 'img');
  assert.ok(fs.readdirSync(cacheDir).length > 0, 'expected cache files after render');
});

test('render default export: rejects unknown flags', async (t) => {
  withSiteRoot(t);
  const renderCmd = (await import('../../src/cli/render.ts')).default;
  await assert.rejects(renderCmd(['--bogus']), /unknown flag/);
});

test('render default export: rejects bad --concurrency', async (t) => {
  withSiteRoot(t);
  const renderCmd = (await import('../../src/cli/render.ts')).default;
  await assert.rejects(renderCmd(['--concurrency', 'not-a-number']), /positive integer/);
});

test('render default export: rejects bad --since', async (t) => {
  withSiteRoot(t);
  const renderCmd = (await import('../../src/cli/render.ts')).default;
  await assert.rejects(renderCmd(['--since', 'not-a-date']), /invalid date/);
});

test('gc default export: prints summary line and runs to completion', async (t) => {
  withSiteRoot(t);
  const gcCmd = (await import('../../src/cli/gc.ts')).default;
  await gcCmd([]); // no exception = success
});

test('verify default export: 0 mismatches → no exit code change', async (t) => {
  const { root } = withSiteRoot(t);
  await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });

  const prevExit = process.exitCode;
  process.exitCode = 0;
  try {
    const verifyCmd = (await import('../../src/cli/verify.ts')).default;
    await verifyCmd([]);
    assert.notEqual(process.exitCode, 1, 'clean tree must not set exit code 1');
  } finally {
    process.exitCode = prevExit;
  }
});

test('verify default export: mismatch → process.exitCode = 1', async (t) => {
  const { root } = withSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });

  // Corrupt original to force hash-mismatch.
  fs.writeFileSync(originalPath(root, r.id, r.ext), Buffer.from('not the real bytes'));

  const prevExit = process.exitCode;
  process.exitCode = 0;
  try {
    const verifyCmd = (await import('../../src/cli/verify.ts')).default;
    await verifyCmd([]);
    assert.equal(process.exitCode, 1, 'mismatch must set exit code 1');
  } finally {
    process.exitCode = prevExit;
  }
});

test('reindex default export: runs and prints summary', async (t) => {
  const { root } = withSiteRoot(t);
  fs.writeFileSync(
    path.join(root, 'content', 'posts', 'a.md'),
    `---\nslug: a\ntitle: A\nstatus: published\n---\n\nbody\n`
  );
  const reindexCmd = (await import('../../src/cli/reindex.ts')).default;
  await reindexCmd([]);
});
