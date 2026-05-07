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
