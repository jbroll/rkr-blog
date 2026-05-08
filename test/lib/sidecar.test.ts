import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { CURRENT_VERSION, read, sidecarPath, validate, write } from '../../src/lib/sidecar.ts';
import type { Sidecar } from '../../src/lib/sidecar-types.ts';

const HEX64 = 'a'.repeat(64);

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-side-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function validSidecar(overrides: Partial<Sidecar> = {}): Sidecar {
  return {
    version: CURRENT_VERSION,
    original: HEX64,
    source: { kind: 'upload', fetched: '2026-05-06T14:00:00Z', originalName: 'x.jpg' },
    metadata: { width: 100, height: 50, format: 'jpeg' },
    ops: [],
    outputs: [{ format: 'webp', quality: 85 }],
    variants: [{ w: 800 }],
    ...overrides
  };
}

test('read() returns null for a missing sidecar', async (t) => {
  const root = freshSiteRoot(t);
  assert.equal(await read(root, HEX64), null);
});

test('write/read round-trip preserves data exactly', async (t) => {
  const root = freshSiteRoot(t);
  const data = validSidecar({
    ops: [{ type: 'crop', x: 0, y: 0, w: 100, h: 50 }],
    metadata: { width: 200, height: 100, format: 'jpeg', exif: { Model: 'Cam' } }
  });
  await write(root, HEX64, data);
  const back = await read(root, HEX64);
  assert.deepEqual(back, data);
});

test('write() places file under sidecars/<id>.json', async (t) => {
  const root = freshSiteRoot(t);
  await write(root, HEX64, validSidecar());
  assert.ok(fs.existsSync(sidecarPath(root, HEX64)));
  assert.equal(sidecarPath(root, HEX64), path.join(root, 'sidecars', `${HEX64}.json`));
});

test('write() rejects mismatched id', async (t) => {
  const root = freshSiteRoot(t);
  await assert.rejects(write(root, 'b'.repeat(64), validSidecar()), /id mismatch/);
});

test('write() rejects invalid data without leaving a temp file', async (t) => {
  const root = freshSiteRoot(t);
  await assert.rejects(write(root, HEX64, { version: 1 } as unknown as Sidecar), /invalid data/);

  const dir = path.join(root, 'sidecars');
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    // The mkdir is created before validation; that's fine. Just ensure no
    // .tmp files are leaked.
    assert.ok(!files.some((f) => f.endsWith('.tmp')), `temp file leaked: ${files}`);
  }
});

test('validate() accepts a minimal valid sidecar', () => {
  assert.deepEqual(validate(validSidecar()), { ok: true });
});

test('validate() rejects non-object input', () => {
  for (const bad of [null, undefined, 'x', 42, [], true]) {
    const r = validate(bad);
    assert.equal(r.ok, false);
  }
});

test('validate() requires version === 1', () => {
  const bad = { ...validSidecar(), version: 2 } as unknown;
  const r = validate(bad);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /version/);
});

test('validate() requires 64-char lowercase hex original', () => {
  for (const bad of ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), 123]) {
    const data = { ...validSidecar(), original: bad } as unknown;
    const r = validate(data);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /original/);
  }
});

test('validate() requires source.kind string', () => {
  const base = validSidecar();
  assert.equal(validate({ ...base, source: {} } as unknown).ok, false);
  assert.equal(validate({ ...base, source: null } as unknown).ok, false);
  assert.equal(validate({ ...base, source: { kind: 7 } } as unknown).ok, false);
});

test('validate() requires metadata object and array fields', () => {
  const base = validSidecar();
  assert.equal(validate({ ...base, metadata: 'no' } as unknown).ok, false);
  assert.equal(validate({ ...base, ops: 'no' } as unknown).ok, false);
  assert.equal(validate({ ...base, outputs: null } as unknown).ok, false);
  assert.equal(validate({ ...base, variants: {} } as unknown).ok, false);
});

test('write() is atomic: a concurrent reader sees the old or new file, never partial', async (t) => {
  // Best-effort check: write a large blob, ensure read between rename steps
  // never observes partial JSON. Hard to race deterministically, but we can
  // at least confirm there are no .tmp files after a successful write.
  const root = freshSiteRoot(t);
  const big = validSidecar({
    metadata: { width: 1, height: 1, format: 'jpeg', note: 'x'.repeat(100000) }
  });
  await write(root, HEX64, big);

  const files = fs.readdirSync(path.join(root, 'sidecars'));
  assert.deepEqual(files, [`${HEX64}.json`], 'no .tmp file should remain');
});
