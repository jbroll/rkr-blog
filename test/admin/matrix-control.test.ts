// Unit coverage for lib/matrix.ts — the shared parse + serialize the
// editor's visual control and the server-side figure renderer both
// use. The DOM wiring (mountMatrixControl in admin/matrix-control.ts)
// is exercised end-to-end by the editor flow spec.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseMatrix, serializeMatrix } from '../../src/lib/matrix.ts';

const adminParse = parseMatrix;

test('parseMatrix: empty + default → Grid 1×1', () => {
  assert.deepEqual(adminParse(''), { kind: 'grid', rows: 1, cols: 1 });
  assert.deepEqual(adminParse('1x1'), { kind: 'grid', rows: 1, cols: 1 });
});

test('parseMatrix: NxM with clamping', () => {
  assert.deepEqual(adminParse('2x3'), { kind: 'grid', rows: 2, cols: 3 });
  // The clamp caps each dim at 12; 99x99 reads back as 12x12.
  assert.deepEqual(adminParse('99x99'), { kind: 'grid', rows: 12, cols: 12 });
  // Zero / negative dims clamp up to 1, not throw.
  assert.deepEqual(adminParse('0x0'), { kind: 'grid', rows: 1, cols: 1 });
});

test('parseMatrix: justified + masonry with and without param', () => {
  assert.deepEqual(adminParse('justified'), { kind: 'justified', param: 240 });
  assert.deepEqual(adminParse('justified:320'), { kind: 'justified', param: 320 });
  assert.deepEqual(adminParse('masonry'), { kind: 'masonry', param: 3 });
  assert.deepEqual(adminParse('masonry:5'), { kind: 'masonry', param: 5 });
});

test('parseMatrix: garbage falls back to the default Grid 1×1', () => {
  assert.deepEqual(adminParse('banana'), { kind: 'grid', rows: 1, cols: 1 });
  assert.deepEqual(adminParse('1x2x3'), { kind: 'grid', rows: 1, cols: 1 });
});

test('serializeMatrix: Grid 1×1 collapses to the empty string', () => {
  // Single-image figures historically carry an empty matrix; emitting
  // '1x1' on every edit would noisy up the markdown for no behaviour
  // change (parseMatrix maps both to the same default spec).
  assert.equal(serializeMatrix({ kind: 'grid', rows: 1, cols: 1 }), '');
});

test('serializeMatrix: non-default Grid emits NxM', () => {
  assert.equal(serializeMatrix({ kind: 'grid', rows: 1, cols: 2 }), '1x2');
  assert.equal(serializeMatrix({ kind: 'grid', rows: 2, cols: 3 }), '2x3');
});

test('serializeMatrix: justified omits :H when it matches the default', () => {
  assert.equal(serializeMatrix({ kind: 'justified', param: 240 }), 'justified');
  assert.equal(serializeMatrix({ kind: 'justified', param: 320 }), 'justified:320');
});

test('serializeMatrix: masonry omits :N when it matches the default', () => {
  assert.equal(serializeMatrix({ kind: 'masonry', param: 3 }), 'masonry');
  assert.equal(serializeMatrix({ kind: 'masonry', param: 5 }), 'masonry:5');
});

test('round-trip: parse → serialize → parse is a fixed point', () => {
  const cases = ['', '1x2', '2x3', '5x5', 'justified', 'justified:300', 'masonry', 'masonry:4'];
  for (const raw of cases) {
    const once = adminParse(raw);
    const twice = adminParse(serializeMatrix(once));
    assert.deepEqual(twice, once, raw);
  }
});

// Non-string inputs (passed via the figure attrs map, where unknown
// is the declared type) fall back to the default rather than throw.
test('parseMatrix: non-string input → default', () => {
  assert.deepEqual(parseMatrix(undefined), { kind: 'grid', rows: 1, cols: 1 });
  assert.deepEqual(parseMatrix(null), { kind: 'grid', rows: 1, cols: 1 });
  assert.deepEqual(parseMatrix(42), { kind: 'grid', rows: 1, cols: 1 });
});
