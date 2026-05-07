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
  opsEqual,
  reorderForExecution,
  resampleRatio,
  scaleCropOp
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

// ---- pipeline reordering -----------------------------------------------
// User directive: resample should be an early pipeline stage. Storage
// (sidecar.ops) keeps click order; execution hoists resample to first
// and scales crop coords on ops that originally preceded it. This lets
// every subsequent op operate on a small canvas instead of the master.

test('resampleRatio: w-bounded resample preserves aspect (returns w/srcW)', () => {
  // 4000×3000 bounded by w=1600 → ratio 0.4.
  const ratio = resampleRatio(4000, 3000, { type: 'resample', w: 1600, fit: 'inside' });
  assert.equal(ratio, 0.4);
});

test('resampleRatio: target ≥ source returns 1 (withoutEnlargement)', () => {
  // The pipeline never upscales; a target larger than source is a no-op.
  const ratio = resampleRatio(800, 600, { type: 'resample', w: 1600, fit: 'inside' });
  assert.equal(ratio, 1);
});

test('scaleCropOp: scales x/y/w/h by ratio and clamps to non-negative', () => {
  const scaled = scaleCropOp({ type: 'crop', x: 1000, y: 500, w: 2000, h: 1500 }, 0.4);
  assert.deepEqual(scaled, { type: 'crop', x: 400, y: 200, w: 800, h: 600 });
});

test('scaleCropOp: non-crop op passes through unchanged', () => {
  // Rotate / flip don't depend on absolute coords; only crop shifts.
  const op = { type: 'rotate', degrees: 90 };
  assert.equal(scaleCropOp(op, 0.4), op);
});

test('reorderForExecution: hoists resample, scales preceding crop coords', () => {
  // User clicked: crop a 4000-space region, then resample to 1600.
  // Execution should resample first, then a crop with coords scaled
  // by 0.4 (so the same region of the original is selected, but
  // operating on the 1600-space canvas).
  const exec = reorderForExecution(
    [
      { type: 'crop', x: 1000, y: 500, w: 2000, h: 1500 },
      { type: 'resample', w: 1600, fit: 'inside' }
    ],
    4000,
    3000
  );
  assert.equal(exec.length, 2);
  assert.equal(exec[0]?.type, 'resample');
  assert.deepEqual(exec[1], { type: 'crop', x: 400, y: 200, w: 800, h: 600 });
});

test('reorderForExecution: ops after resample pass through unchanged', () => {
  // Only ops that originally PRECEDED the resample need scaling.
  // Anything after stays in its given form (it was already authored
  // in resample-space conceptually).
  const exec = reorderForExecution(
    [
      { type: 'resample', w: 1600, fit: 'inside' },
      { type: 'crop', x: 100, y: 50, w: 200, h: 150 },
      { type: 'rotate', degrees: 90 }
    ],
    4000,
    3000
  );
  assert.equal(exec[0]?.type, 'resample');
  // Unchanged crop coords.
  assert.deepEqual(exec[1], { type: 'crop', x: 100, y: 50, w: 200, h: 150 });
  assert.deepEqual(exec[2], { type: 'rotate', degrees: 90 });
});

test('reorderForExecution: no resample → ops in click order', () => {
  // Without a resample, there's nothing to reorder; everything stays.
  const ops = [
    { type: 'crop', x: 0, y: 0, w: 100, h: 100 },
    { type: 'rotate', degrees: 90 }
  ];
  assert.deepEqual(reorderForExecution(ops, 800, 600), ops);
});

test('reorderForExecution: rotate/flip preceding resample pass through (no coord scaling)', () => {
  // Rotate/flip don't have coords; they pass through. The resample
  // still gets hoisted.
  const exec = reorderForExecution(
    [
      { type: 'rotate', degrees: 90 },
      { type: 'flip', axis: 'horizontal' },
      { type: 'resample', w: 800, fit: 'inside' }
    ],
    1600,
    1200
  );
  assert.equal(exec[0]?.type, 'resample');
  assert.deepEqual(exec[1], { type: 'rotate', degrees: 90 });
  assert.deepEqual(exec[2], { type: 'flip', axis: 'horizontal' });
});

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
