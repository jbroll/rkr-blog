// Unit coverage for the pure-math helpers in src/admin/canvas-math.ts.
// canvas.ts itself touches the DOM (createElement, getContext,
// drawImage) and is exercised manually via the editor — Node has no
// canvas context. The geometry math here is a regression-magnet: a
// rounding bug or off-by-one in resample geometry makes preview drift
// from the published render.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clampInt,
  computeResampleSize,
  normalizeRotation,
  opsEqual
} from '../../src/admin/canvas-math.ts';

test('computeResampleSize: w only (downscale, preserves aspect)', () => {
  // 800×600 bounded by w=400 → scale 0.5; h follows.
  assert.deepEqual(computeResampleSize(800, 600, 400, undefined, 'inside'), {
    width: 400,
    height: 300
  });
});

test('computeResampleSize: h only (downscale, preserves aspect)', () => {
  // 800×600 bounded by h=300 → scale 0.5; w follows.
  assert.deepEqual(computeResampleSize(800, 600, undefined, 300, 'inside'), {
    width: 400,
    height: 300
  });
});

test('computeResampleSize: w+h with inside picks the smaller scale', () => {
  // 800×600 bounded by 400×400: w-bound scale = 0.5, h-bound scale = 0.667.
  // Inside takes the smaller (0.5) so the result fits inside the box.
  assert.deepEqual(computeResampleSize(800, 600, 400, 400, 'inside'), {
    width: 400,
    height: 300
  });
});

test('computeResampleSize: never enlarges (matches sharp withoutEnlargement)', () => {
  // A target larger than the source returns the source unchanged.
  // Sharp's default + ours: don't blow pixels up.
  assert.deepEqual(computeResampleSize(400, 300, 800, undefined, 'inside'), {
    width: 400,
    height: 300
  });
});

test('computeResampleSize: fill stretches to exact w×h', () => {
  // Fill mode ignores aspect ratio and produces the requested
  // dimensions; the editor doesn't emit this today but supporting it
  // means a later UI affordance can opt in without re-engineering.
  assert.deepEqual(computeResampleSize(800, 600, 200, 200, 'fill'), {
    width: 200,
    height: 200
  });
});

test('computeResampleSize: missing w and h returns source size', () => {
  // No bounds at all → no-op. The caller should generally not pass
  // a resample op without dimensions, but handle it gracefully.
  assert.deepEqual(computeResampleSize(800, 600, undefined, undefined, 'inside'), {
    width: 800,
    height: 600
  });
});

test('computeResampleSize: rounds to integer pixel sizes', () => {
  // 1001×750 with w=500 → scale 0.4995 → height 374.625 rounds to 375.
  // Canvas dimensions must be integers; verify the rounding doesn't
  // produce zero or negative values.
  const out = computeResampleSize(1001, 750, 500, undefined, 'inside');
  assert.equal(Number.isInteger(out.width), true);
  assert.equal(Number.isInteger(out.height), true);
  assert.ok(out.width > 0);
  assert.ok(out.height > 0);
});

test('clampInt: clamps + floors numeric input', () => {
  assert.equal(clampInt(5.7, 0, 10), 5);
  assert.equal(clampInt(-3, 0, 10), 0);
  assert.equal(clampInt(99, 0, 10), 10);
});

test('clampInt: non-finite input collapses to lo', () => {
  // Used as a defensive fallback when a sidecar op has garbage; the
  // canvas pipeline should not throw on garbage input — the server
  // already validated shape, but keep the client robust.
  assert.equal(clampInt(Number.NaN, 0, 10), 0);
  assert.equal(clampInt('xx', 5, 10), 5);
  assert.equal(clampInt(undefined, 5, 10), 5);
});

test('normalizeRotation: maps multiples of 90 into [0, 360)', () => {
  assert.equal(normalizeRotation(0), 0);
  assert.equal(normalizeRotation(90), 90);
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(450), 90);
  assert.equal(normalizeRotation(-180), 180);
});

test('normalizeRotation: non-orthogonal or non-finite returns null', () => {
  // The server rejects non-multiples of 90 at validate time, but the
  // client should also no-op rather than rotate at an arbitrary angle.
  assert.equal(normalizeRotation(45), null);
  assert.equal(normalizeRotation(Number.NaN), null);
  assert.equal(normalizeRotation('x'), null);
});

// ---- op equality ------------------------------------------------------
// PipelineCache uses opsEqual to test whether the new ops list is the
// previous list with one op appended. Robust against key order so two
// JSON-equivalent ops compare equal regardless of how they were built.

test('opsEqual: same shape ops compare equal regardless of key order', () => {
  // {type, x, y} == {y, x, type}. Used by the incremental cache to
  // detect "same op as before" when checking if a new ops list is the
  // previous list with one new op appended.
  assert.equal(opsEqual({ type: 'crop', x: 1, y: 2 }, { type: 'crop', y: 2, x: 1 }), true);
});

test('opsEqual: differing values compare unequal', () => {
  assert.equal(opsEqual({ type: 'rotate', degrees: 90 }, { type: 'rotate', degrees: 180 }), false);
});

test('opsEqual: differing types compare unequal', () => {
  assert.equal(opsEqual({ type: 'crop' }, { type: 'rotate' }), false);
});
