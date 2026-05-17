// Regression: a published post (e.g. /about) flashed 404 during an
// editor save because the save used fs.writeFile (truncate-then-write),
// so a concurrent reader could parse an empty/partial file. The fix is
// writeFileAtomic (temp file + rename). These tests pin the atomicity
// contract: the destination is never left absent/partial, and on a
// write failure the original is untouched with no temp residue.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { writeFileAtomic, writeFileAtomicSync } from '../../src/lib/atomic-write.ts';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-atomic-'));
}

test('writeFileAtomic: creates the file with the given content', async () => {
  const dir = tmpdir();
  const f = path.join(dir, 'post.md');
  await writeFileAtomic(f, 'hello');
  assert.equal(fs.readFileSync(f, 'utf8'), 'hello');
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')),
    [],
    'no temp file left behind'
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic: replaces existing content, no temp residue', async () => {
  const dir = tmpdir();
  const f = path.join(dir, 'post.md');
  fs.writeFileSync(f, 'OLD');
  await writeFileAtomic(f, 'NEW');
  assert.equal(fs.readFileSync(f, 'utf8'), 'NEW');
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')),
    []
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic: on rename failure the original is preserved and no temp leaks', async () => {
  const dir = tmpdir();
  const f = path.join(dir, 'post.md');
  fs.writeFileSync(f, 'ORIGINAL-INTACT');

  const realRename = fs.promises.rename;
  // Force the rename step to fail (this is exactly the window where
  // the old code, having already truncated `f`, would leave it empty).
  (fs.promises as { rename: typeof fs.promises.rename }).rename = async () => {
    throw new Error('simulated rename failure');
  };
  try {
    await assert.rejects(() => writeFileAtomic(f, 'SHOULD-NOT-LAND'), /simulated rename failure/);
  } finally {
    (fs.promises as { rename: typeof fs.promises.rename }).rename = realRename;
  }

  // The atomicity guarantee: the destination is untouched (NOT empty,
  // NOT the new content) and no temp file is orphaned.
  assert.equal(fs.readFileSync(f, 'utf8'), 'ORIGINAL-INTACT');
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')),
    []
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomicSync: creates/replaces content, no temp residue', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'site.json');
  writeFileAtomicSync(f, '{"a":1}');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}');
  fs.writeFileSync(f, 'OLD');
  writeFileAtomicSync(f, 'NEW');
  assert.equal(fs.readFileSync(f, 'utf8'), 'NEW');
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')),
    []
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomicSync: rename failure preserves original, no temp leak', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'site.json');
  fs.writeFileSync(f, 'ORIGINAL');
  const realRename = fs.renameSync;
  (fs as { renameSync: typeof fs.renameSync }).renameSync = () => {
    throw new Error('simulated renameSync failure');
  };
  try {
    assert.throws(() => writeFileAtomicSync(f, 'NOPE'), /simulated renameSync failure/);
  } finally {
    (fs as { renameSync: typeof fs.renameSync }).renameSync = realRename;
  }
  assert.equal(fs.readFileSync(f, 'utf8'), 'ORIGINAL');
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')),
    []
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
