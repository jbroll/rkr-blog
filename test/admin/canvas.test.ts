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
  computeHomography,
  computeResampleSize,
  invertMatrix3,
  normalizeRotation,
  opsEqual,
  type Point,
  perspectiveOutputSize,
  simplifyOps
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

// ---- pipeline simplification ------------------------------------------
// Storage stays in click order so the edits panel reflects what the
// user actually did. The executor collapses adjacent logical no-ops
// before running so the canvas pipeline doesn't spend time undoing
// itself: rotate(90) + rotate(-90) is dead code.

test('simplifyOps: combines adjacent rotates into one', () => {
  // rotate(90) + rotate(90) → rotate(180)
  const out = simplifyOps([
    { type: 'rotate', degrees: 90 },
    { type: 'rotate', degrees: 90 }
  ]);
  assert.deepEqual(out, [{ type: 'rotate', degrees: 180 }]);
});

test('simplifyOps: cancelling rotates drop entirely', () => {
  // rotate(90) + rotate(-90) → no-op (sum is 0)
  const out = simplifyOps([
    { type: 'rotate', degrees: 90 },
    { type: 'rotate', degrees: -90 }
  ]);
  assert.deepEqual(out, []);
});

test('simplifyOps: chained rotates sum to canonical 0..360', () => {
  // 90 + 90 + 90 → 90 + 180 → 270 (combined left-to-right by stack)
  const out = simplifyOps([
    { type: 'rotate', degrees: 90 },
    { type: 'rotate', degrees: 90 },
    { type: 'rotate', degrees: 90 }
  ]);
  assert.deepEqual(out, [{ type: 'rotate', degrees: 270 }]);
});

test('simplifyOps: same-axis flip pair cancels', () => {
  // flip(h) + flip(h) → ∅
  const out = simplifyOps([
    { type: 'flip', axis: 'horizontal' },
    { type: 'flip', axis: 'horizontal' }
  ]);
  assert.deepEqual(out, []);
});

test('simplifyOps: cross-axis flips do NOT cancel', () => {
  // h + v is a 180° rotation visually, not a no-op. Don't drop it.
  const ops = [
    { type: 'flip', axis: 'horizontal' },
    { type: 'flip', axis: 'vertical' }
  ];
  assert.deepEqual(simplifyOps(ops), ops);
});

test('simplifyOps: non-adjacent inverses do NOT cancel', () => {
  // rotate(90) + flip(h) + rotate(-90) is NOT a no-op because the flip
  // sits between them; the result is a different transform than identity.
  // simplifyOps only handles adjacency.
  const ops = [
    { type: 'rotate', degrees: 90 },
    { type: 'flip', axis: 'horizontal' },
    { type: 'rotate', degrees: -90 }
  ];
  assert.deepEqual(simplifyOps(ops), ops);
});

test('simplifyOps: leaves crop and resample untouched', () => {
  // Crop and resample don't compose cleanly so we never combine or
  // drop them, even when adjacent.
  const ops = [
    { type: 'crop', x: 0, y: 0, w: 100, h: 100 },
    { type: 'crop', x: 10, y: 10, w: 80, h: 80 },
    { type: 'resample', w: 200 },
    { type: 'resample', w: 100 }
  ];
  assert.deepEqual(simplifyOps(ops), ops);
});

test('simplifyOps: empty input → empty output', () => {
  assert.deepEqual(simplifyOps([]), []);
});

// ---- perspective rectify math -----------------------------------------
// computeHomography solves an 8×8 linear system; round-trip the input
// quadrilateral through H to verify it lands on the dest corners.

function applyH(h: readonly number[], p: Point): [number, number] {
  const [x, y] = p;
  const wx = (h[0] as number) * x + (h[1] as number) * y + (h[2] as number);
  const wy = (h[3] as number) * x + (h[4] as number) * y + (h[5] as number);
  const w = (h[6] as number) * x + (h[7] as number) * y + (h[8] as number);
  return [wx / w, wy / w];
}

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

test('computeHomography: maps four src corners onto four dst corners', () => {
  // Source quadrilateral (a tilted region) → dest rectangle.
  const src: [Point, Point, Point, Point] = [
    [10, 20],
    [110, 5],
    [120, 95],
    [5, 100]
  ];
  const dst: [Point, Point, Point, Point] = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100]
  ];
  const h = computeHomography(src, dst);
  assert.ok(h, 'expected a non-null homography for non-degenerate quad');
  for (let i = 0; i < 4; i++) {
    const got = applyH(h as number[], src[i] as Point);
    const want = dst[i] as Point;
    assert.ok(approx(got[0], want[0] as number), `point ${i} x: got ${got[0]}, want ${want[0]}`);
    assert.ok(approx(got[1], want[1] as number), `point ${i} y: got ${got[1]}, want ${want[1]}`);
  }
});

test('computeHomography: identity quad maps to itself (h ≈ I)', () => {
  // A degenerate-ish but valid case: src == dst → H is identity (up
  // to scale). Round-trip validates: applying H gives back the input.
  const corners: [Point, Point, Point, Point] = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100]
  ];
  const h = computeHomography(corners, corners);
  assert.ok(h);
  for (const p of corners) {
    const got = applyH(h as number[], p);
    assert.ok(approx(got[0], p[0] as number));
    assert.ok(approx(got[1], p[1] as number));
  }
});

test('computeHomography: returns null for degenerate (colinear) source points', () => {
  // Three colinear src points → singular linear system → null.
  const colinear: [Point, Point, Point, Point] = [
    [0, 0],
    [50, 0],
    [100, 0], // all on y=0
    [50, 100]
  ];
  const dst: [Point, Point, Point, Point] = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100]
  ];
  assert.equal(computeHomography(colinear, dst), null);
});

test('invertMatrix3: H · H⁻¹ ≈ I for a non-singular matrix', () => {
  const h = computeHomography(
    [
      [10, 20],
      [110, 5],
      [120, 95],
      [5, 100]
    ],
    [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100]
    ]
  );
  assert.ok(h);
  const inv = invertMatrix3(h as number[]);
  assert.ok(inv, 'non-singular H should be invertible');
  // Multiply h * inv and check it's approximately I.
  function mul(a: readonly number[], b: readonly number[]): number[] {
    const r = new Array<number>(9).fill(0);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += (a[i * 3 + k] as number) * (b[k * 3 + j] as number);
        r[i * 3 + j] = s;
      }
    return r;
  }
  const I = mul(h as number[], inv as number[]);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const want = i === j ? 1 : 0;
      assert.ok(
        approx(I[i * 3 + j] as number, want, 1e-6),
        `I[${i},${j}]: got ${I[i * 3 + j]}, want ${want}`
      );
    }
});

test('invertMatrix3: returns null for a singular matrix', () => {
  // Rank-deficient: rows 2 and 3 are identical → det = 0.
  const m = [1, 2, 3, 4, 5, 6, 4, 5, 6];
  assert.equal(invertMatrix3(m), null);
});

test('perspectiveOutputSize: averages top/bottom and left/right edges', () => {
  // tl=(0,0) tr=(100,0) br=(100,80) bl=(0,80) → 100×80 axis-aligned.
  const out = perspectiveOutputSize([
    [0, 0],
    [100, 0],
    [100, 80],
    [0, 80]
  ]);
  assert.deepEqual(out, { w: 100, h: 80 });
});

test('perspectiveOutputSize: tilted square produces square-ish output', () => {
  // A 100-unit square rotated 30°: edge lengths stay 100, so output
  // should be 100×100 regardless of the AABB (which would be larger).
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  const corners: [Point, Point, Point, Point] = [
    [0, 0],
    [100 * c, 100 * s],
    [100 * c - 100 * s, 100 * s + 100 * c],
    [-100 * s, 100 * c]
  ];
  const out = perspectiveOutputSize(corners);
  assert.equal(out.w, 100);
  assert.equal(out.h, 100);
});

test('simplifyOps: simplification cascades after combining', () => {
  // After combining the two -180s into 0 (drop), the surrounding
  // [rotate 90, rotate 90] become adjacent and combine to 180.
  // The current implementation walks left-to-right with a stack, so
  // verify the cascade works.
  const out = simplifyOps([
    { type: 'rotate', degrees: 90 },
    { type: 'rotate', degrees: -180 },
    { type: 'rotate', degrees: 180 },
    { type: 'rotate', degrees: 90 }
  ]);
  // 90 + (-180) = -90 → 270; 270 + 180 = 450 → 90; 90 + 90 = 180.
  assert.deepEqual(out, [{ type: 'rotate', degrees: 180 }]);
});
