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

/** Loose op shape — same one canvas.ts uses. We re-declare here rather
 * than import from canvas.ts so the canvas-math module stays free of
 * DOM-typed siblings. */
type Op = { type: string; [k: string]: unknown };

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

/** Simplify an op list for execution by collapsing adjacent logical
 * no-ops:
 *   - Adjacent rotates combine: rotate(a) + rotate(b) → rotate((a+b) mod 360),
 *     dropped entirely if the sum is 0.
 *   - Adjacent same-axis flips cancel: flip(h) + flip(h) → ∅.
 *
 * Storage (sidecar.ops) stays untouched — the edits panel still
 * reflects the user's click history; only execution is simplified.
 * Crop and resample don't compose cleanly so they pass through. */
export function simplifyOps(ops: readonly Op[]): Op[] {
  const out: Op[] = [];
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
