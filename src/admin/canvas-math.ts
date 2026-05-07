// Pure-math helpers for the client canvas pipeline. Lives in its own
// module so the server-side test runner can import it without dragging
// in DOM types (canvas.ts itself touches HTMLCanvasElement and friends,
// which only exist under the browser tsconfig's lib).

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

// ---- pipeline reordering -----------------------------------------------
// User directive: "resample should be an early pipeline stage."
//
// Storage stays in click order (the edits panel reflects the user's
// actions). Execution reorders so resample runs first — this lets every
// subsequent op work on a small canvas instead of the full master.
// Crop coords on ops that originally preceded the resample are scaled
// down proportionally so the post-resample crop selects the same region
// the user picked in original-pixel space.
//
// This module is DOM-free; canvas.ts wires it up to the actual rendering.

/** Loose op shape — same one canvas.ts uses. We re-declare here rather
 * than import from canvas.ts so the canvas-math module stays free of
 * DOM-typed siblings. */
type Op = { type: string; [k: string]: unknown };

/** Compute the post-resample width:source-width ratio for a resample op,
 * given the source canvas dimensions. Used to scale crop coords that
 * originally preceded the resample in click order. */
export function resampleRatio(srcW: number, srcH: number, op: Op): number {
  const targetW = op.w !== undefined ? Number(op.w) : undefined;
  const targetH = op.h !== undefined ? Number(op.h) : undefined;
  const fit = typeof op.fit === 'string' ? op.fit : 'inside';
  const { width: outW } = computeResampleSize(srcW, srcH, targetW, targetH, fit);
  return outW / srcW;
}

/** Scale a crop op's coords by `ratio`. Non-crop ops pass through
 * unchanged (rotate/flip don't depend on absolute coords). */
export function scaleCropOp(op: Op, ratio: number): Op {
  if (op.type !== 'crop') return op;
  return {
    type: 'crop',
    x: Math.max(0, Math.round(Number(op.x) * ratio)),
    y: Math.max(0, Math.round(Number(op.y) * ratio)),
    w: Math.max(1, Math.round(Number(op.w) * ratio)),
    h: Math.max(1, Math.round(Number(op.h) * ratio))
  };
}

/** Rewrite an op list for execution: hoist the first resample to the
 * front; scale crop coords that originally preceded the resample by the
 * resample ratio. Ops after the resample (and ops with no resample at
 * all) pass through in click order. */
export function reorderForExecution(ops: readonly Op[], srcW: number, srcH: number): Op[] {
  const idx = ops.findIndex((o) => o.type === 'resample');
  if (idx === -1 || idx === 0) return [...ops];
  const resample = ops[idx] as Op;
  const ratio = resampleRatio(srcW, srcH, resample);
  // No-op resample (target ≥ source) → ratio is 1; nothing to scale.
  // Still hoist for consistency, though it's a free op at execute time.
  const before = ops.slice(0, idx).map((op) => scaleCropOp(op, ratio));
  const after = ops.slice(idx + 1);
  return [resample, ...before, ...after];
}

/** Stable equality for op records. Sort keys so {type, x, y} == {y, x, type}.
 * Used by the incremental pipeline cache to test "is the new ops list
 * the previous list with one new op appended?" */
export function opsEqual(a: Op, b: Op): boolean {
  return canonicalOp(a) === canonicalOp(b);
}

function canonicalOp(op: Op): string {
  const keys = Object.keys(op).sort();
  return JSON.stringify(keys.map((k) => [k, op[k]]));
}
