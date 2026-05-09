// Pure-math helpers for the client canvas pipeline. Lives in its own
// module so the server-side test runner can import it without dragging
// in DOM types (canvas.ts itself touches HTMLCanvasElement and friends,
// which only exist under the browser tsconfig's lib).

// canonicalJson lives in ../lib/canonical-json.ts; callers import from
// there directly. canvas-math is dual-tsconfig (included by both
// tsconfig.browser.json and visited transitively by tsconfig.json via
// test/admin/canvas.test.ts), so the .ts extension form is required.

/** Compute the post-resample canvas size given the bounds and fit mode.
 * Mirrors sharp's behavior closely enough for live-preview parity:
 * 'inside' (default) preserves aspect, never enlarges; 'fill' stretches;
 * 'cover' / 'contain' / 'outside' fall through to inside-style behavior
 * since the editor only emits 'inside' today. */
export function computeResampleSize(
  srcW: number,
  srcH: number,
  targetW: number | undefined,
  targetH: number | undefined,
  fit: string
): { width: number; height: number } {
  if (fit === 'fill' && targetW !== undefined && targetH !== undefined) {
    return { width: Math.max(1, Math.round(targetW)), height: Math.max(1, Math.round(targetH)) };
  }
  // Treat anything other than 'fill' as inside: preserve aspect; bound
  // by whichever of w/h was supplied.
  let scale = 1;
  if (targetW !== undefined && targetH !== undefined) {
    scale = Math.min(targetW / srcW, targetH / srcH);
  } else if (targetW !== undefined) {
    scale = targetW / srcW;
  } else if (targetH !== undefined) {
    scale = targetH / srcH;
  }
  // Don't enlarge. Sharp's `withoutEnlargement: true` is the default
  // intent for our pipeline (sidecar `variants` are downscale targets).
  if (scale >= 1) return { width: srcW, height: srcH };
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale))
  };
}

/** Floor + clamp into a [lo, hi] integer range. NaN / non-finite input
 * collapses to lo. */
export function clampInt(v: unknown, lo: number, hi: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** Normalize a degrees value to one of {0, 90, 180, 270}. Non-finite or
 * non-multiples-of-90 inputs return null so the caller can no-op. */
export function normalizeRotation(degrees: unknown): 0 | 90 | 180 | 270 | null {
  const n = Number(degrees);
  if (!Number.isFinite(n)) return null;
  const mod = ((n % 360) + 360) % 360;
  if (mod !== 0 && mod !== 90 && mod !== 180 && mod !== 270) return null;
  return mod as 0 | 90 | 180 | 270;
}

/** Loose op shape — same one canvas.ts uses. We re-declare here rather
 * than import from canvas.ts so the canvas-math module stays free of
 * DOM-typed siblings. */
type CanvasOp = { type: string; [k: string]: unknown };

/** Stable equality for op records. Sort keys so {type, x, y} == {y, x, type}.
 * Used by the incremental pipeline cache to test "is the new ops list
 * the previous list with one new op appended?" */
export function opsEqual(a: CanvasOp, b: CanvasOp): boolean {
  return canonicalOp(a) === canonicalOp(b);
}

function canonicalOp(op: CanvasOp): string {
  const keys = Object.keys(op).sort();
  return JSON.stringify(keys.map((k) => [k, op[k]]));
}

// ---- perspective rectify math ----------------------------------------
// The perspective op straightens a tilted quadrilateral region into a
// rectangle (canonical use: de-skewing a photographed document or sign).
// User picks 4 source corners; the executor maps them to (0,0)-(w,h)
// where w/h are derived from the average top/bottom and left/right
// edge lengths of the source quad.
//
// Math here is pure linear algebra; canvas.ts wires it into a WebGL
// shader that does the actual texture sampling per output pixel.

export type Point = readonly [number, number];

/** Solve for the 3×3 row-major homography matrix H mapping the four
 * `src` points to the four `dst` points (so for every i,
 * (H · [src[i].x, src[i].y, 1]) / w == [dst[i].x, dst[i].y]).
 *
 * Solves an 8×8 linear system via Gaussian elimination with partial
 * pivoting. Returns `null` for degenerate inputs (three colinear
 * source points etc.). */
export function computeHomography(
  src: readonly [Point, Point, Point, Point],
  dst: readonly [Point, Point, Point, Point]
): number[] | null {
  // 8 unknowns: h11 h12 h13 h21 h22 h23 h31 h32 (h33 fixed to 1).
  // Each src→dst pair contributes 2 equations.
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i] as Point;
    const [X, Y] = dst[i] as Point;
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }
  const h = solveLinearSystem(A, b);
  if (!h) return null;
  return [
    h[0] as number,
    h[1] as number,
    h[2] as number,
    h[3] as number,
    h[4] as number,
    h[5] as number,
    h[6] as number,
    h[7] as number,
    1
  ];
}

/** Invert a 3×3 row-major matrix. Returns null when singular. The
 * WebGL shader needs the inverse so it can back-project each output
 * pixel into source-texture space. */
export function invertMatrix3(m: readonly number[]): number[] | null {
  const a = m[0] as number;
  const b = m[1] as number;
  const c = m[2] as number;
  const d = m[3] as number;
  const e = m[4] as number;
  const f = m[5] as number;
  const g = m[6] as number;
  const h = m[7] as number;
  const i = m[8] as number;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return [
    A * inv,
    -(b * i - c * h) * inv,
    (b * f - c * e) * inv,
    B * inv,
    (a * i - c * g) * inv,
    -(a * f - c * d) * inv,
    C * inv,
    -(a * h - b * g) * inv,
    (a * e - b * d) * inv
  ];
}

/** Compute a sensible output size for a perspective rectify given the
 * four source corners (in tl/tr/br/bl order). Uses the average of
 * top/bottom edge lengths for width and left/right edge lengths for
 * height — produces an output rectangle with aspect ratio close to
 * the underlying physical region rather than the source AABB. */
export function perspectiveOutputSize(corners: readonly [Point, Point, Point, Point]): {
  w: number;
  h: number;
} {
  const [tl, tr, br, bl] = corners;
  const topW = distance(tl, tr);
  const botW = distance(bl, br);
  const leftH = distance(tl, bl);
  const rightH = distance(tr, br);
  return {
    w: Math.max(1, Math.round((topW + botW) / 2)),
    h: Math.max(1, Math.round((leftH + rightH) / 2))
  };
}

function distance(a: Point, b: Point): number {
  const dx = (a[0] as number) - (b[0] as number);
  const dy = (a[1] as number) - (b[1] as number);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Gaussian elimination with partial pivoting for an n×n linear
 * system. Returns the solution vector or null if singular. */
function solveLinearSystem(
  A: readonly (readonly number[])[],
  b: readonly number[]
): number[] | null {
  const n = A.length;
  // Augmented matrix copy so we don't mutate the caller's data.
  const M: number[][] = A.map((row, i) => [...row, b[i] as number]);
  for (let i = 0; i < n; i++) {
    // Partial pivot: pick the largest-magnitude row in column i.
    let pivot = i;
    const Mi = M[i] as number[];
    for (let k = i + 1; k < n; k++) {
      if (Math.abs((M[k] as number[])[i] as number) > Math.abs(Mi[i] as number)) pivot = k;
    }
    if (pivot !== i) {
      const tmp = M[i] as number[];
      M[i] = M[pivot] as number[];
      M[pivot] = tmp;
    }
    const pivotRow = M[i] as number[];
    if (Math.abs(pivotRow[i] as number) < 1e-12) return null;
    for (let k = i + 1; k < n; k++) {
      const row = M[k] as number[];
      const factor = (row[i] as number) / (pivotRow[i] as number);
      for (let j = i; j <= n; j++) {
        row[j] = (row[j] as number) - factor * (pivotRow[j] as number);
      }
    }
  }
  // Back-substitution.
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const row = M[i] as number[];
    let sum = row[n] as number;
    for (let j = i + 1; j < n; j++) sum -= (row[j] as number) * (x[j] as number);
    x[i] = sum / (row[i] as number);
  }
  return x;
}

/** Simplify an op list for execution by collapsing adjacent logical
 * no-ops:
 *   - Adjacent rotates combine: rotate(a) + rotate(b) → rotate((a+b) mod 360),
 *     dropped entirely if the sum is 0.
 *   - Adjacent same-axis flips cancel: flip(h) + flip(h) → ∅.
 *
 * Storage (sidecar.ops) stays untouched — the edits panel still
 * reflects the user's click history; only execution is simplified.
 * Crop and resample don't compose cleanly so they pass through. */
export function simplifyOps(ops: readonly CanvasOp[]): CanvasOp[] {
  const out: CanvasOp[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (op.type === 'rotate' && last && last.type === 'rotate') {
      const sum = (((Number(last.degrees) + Number(op.degrees)) % 360) + 360) % 360;
      out.pop();
      if (sum !== 0) out.push({ type: 'rotate', degrees: sum });
    } else if (op.type === 'flip' && last && last.type === 'flip' && last.axis === op.axis) {
      // Two flips on the same axis cancel. Cross-axis flips are NOT
      // a no-op (h+v == 180° rotation visually) so we leave them.
      out.pop();
    } else {
      out.push(op);
    }
  }
  return out;
}
