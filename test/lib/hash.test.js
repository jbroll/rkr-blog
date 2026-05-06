import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { cacheKey, canonicalJson, sha256File, sha256Stream } from '../../src/lib/hash.js';

// ---- canonicalJson -----------------------------------------------------

test('canonicalJson: scalars', () => {
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson(true), 'true');
  assert.equal(canonicalJson(false), 'false');
  assert.equal(canonicalJson(0), '0');
  assert.equal(canonicalJson(-1), '-1');
  assert.equal(canonicalJson(3.14), '3.14');
  assert.equal(canonicalJson('hello'), '"hello"');
});

test('canonicalJson: numbers strip trailing zeros (Number.prototype.toString)', () => {
  // Numbers with trailing zeros after the decimal are normalized by JS.
  assert.equal(canonicalJson(1.0), '1');
  assert.equal(canonicalJson(1.5), '1.5');
  assert.equal(canonicalJson(2.5), '2.5');
});

test('canonicalJson: object keys sorted, no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  // Nested.
  assert.equal(
    canonicalJson({ z: { y: 1, x: 2 }, a: [3, { c: 4, b: 5 }] }),
    '{"a":[3,{"b":5,"c":4}],"z":{"x":2,"y":1}}'
  );
});

test('canonicalJson: undefined members are dropped, undefined value throws', () => {
  assert.equal(canonicalJson({ a: 1, b: undefined, c: 2 }), '{"a":1,"c":2}');
  assert.throws(() => canonicalJson(undefined), /undefined/);
});

test('canonicalJson: non-ASCII characters escape as \\uXXXX', () => {
  // U+00E9 LATIN SMALL LETTER E WITH ACUTE
  assert.equal(canonicalJson('café'), '"caf\\u00e9"');
  // U+1F600 GRINNING FACE → surrogate pair, escaped per code unit
  assert.equal(canonicalJson('\u{1F600}'), '"\\ud83d\\ude00"');
});

test('canonicalJson: NaN/Infinity throw (no canonical form)', () => {
  assert.throws(() => canonicalJson(NaN), /non-finite/);
  assert.throws(() => canonicalJson(Infinity), /non-finite/);
});

test('canonicalJson: bigint/symbol/function throw', () => {
  assert.throws(() => canonicalJson(1n), /unsupported/);
  assert.throws(() => canonicalJson(Symbol('s')), /unsupported/);
  assert.throws(() => canonicalJson(() => {}), /unsupported/);
});

test('canonicalJson: deterministic across key insertion order', () => {
  const a = { x: 1, y: 2, z: 3 };
  const b = { z: 3, y: 2, x: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
});

// ---- cacheKey -----------------------------------------------------------

test('cacheKey: 12 lowercase hex chars', () => {
  const key = cacheKey({
    originalId: 'a'.repeat(64),
    ops: [{ type: 'crop', x: 0, y: 0, w: 100, h: 100 }],
    variant: { w: 800 },
    output: { format: 'webp', quality: 85 }
  });
  assert.match(key, /^[0-9a-f]{12}$/);
});

test('cacheKey: deterministic given identical args (any key order)', () => {
  const a = cacheKey({
    originalId: 'abc',
    ops: [{ type: 'resample', w: 400, fit: 'inside' }],
    variant: { w: 400 },
    output: { format: 'avif', quality: 70 }
  });
  const b = cacheKey({
    output: { quality: 70, format: 'avif' },
    variant: { w: 400 },
    ops: [{ fit: 'inside', w: 400, type: 'resample' }],
    originalId: 'abc'
  });
  assert.equal(a, b);
});

test('cacheKey: differs when ops differ', () => {
  const base = { originalId: 'abc', variant: { w: 800 }, output: { format: 'webp', quality: 85 } };
  const k1 = cacheKey({ ...base, ops: [{ type: 'crop', x: 0, y: 0, w: 100, h: 100 }] });
  const k2 = cacheKey({ ...base, ops: [{ type: 'crop', x: 0, y: 0, w: 100, h: 101 }] });
  assert.notEqual(k1, k2);
});

test('cacheKey: differs when output format/quality differ', () => {
  const base = { originalId: 'abc', ops: [], variant: { w: 800 } };
  const a = cacheKey({ ...base, output: { format: 'webp', quality: 85 } });
  const b = cacheKey({ ...base, output: { format: 'webp', quality: 80 } });
  const c = cacheKey({ ...base, output: { format: 'avif', quality: 85 } });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
});

// ---- sha256File / sha256Stream -----------------------------------------

test('sha256Stream matches reference sha256 of the same bytes', async () => {
  const data = Buffer.from('the quick brown fox jumps over the lazy dog');
  const expected = crypto.createHash('sha256').update(data).digest('hex');
  const stream = Readable.from([data]);
  const actual = await sha256Stream(stream);
  assert.equal(actual, expected);
});

test('sha256File matches sha256Stream on the same bytes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-hash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const data = crypto.randomBytes(1024 * 64); // 64 KiB
  const file = path.join(dir, 'blob.bin');
  fs.writeFileSync(file, data);

  const fromFile = await sha256File(file);
  const fromStream = await sha256Stream(Readable.from([data]));
  const reference = crypto.createHash('sha256').update(data).digest('hex');

  assert.equal(fromFile, reference);
  assert.equal(fromStream, reference);
});

test('sha256Stream propagates stream errors', async () => {
  const stream = new Readable({
    read() {
      this.destroy(new Error('boom'));
    }
  });
  await assert.rejects(sha256Stream(stream), /boom/);
});
