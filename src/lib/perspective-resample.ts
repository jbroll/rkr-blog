// Server-side perspective rectify, in pure JS. Mirrors the editor's
// WebGL pipeline in src/admin/canvas.ts so the server-baked output
// matches what the editor produces for the same op.
//
// Used by widget-helpers.ts:ensureBake when a sidecar has a
// perspective op but the bake is missing on disk (pre-/commit-
// migration leftover, manual delete, etc.). Without this, perspective
// ops would be unrecoverable server-side because sharp / libvips has
// no homography operator.
//
// Algorithm:
//   1. Compute the source→output homography H from the four corners.
//   2. Invert: for each output pixel (x, y), Hinv·[x, y, 1] in
//      homogeneous coords gives the source sample point.
//   3. Bilinearly sample the source RGBA buffer at that point.
//   4. Out-of-bounds samples are transparent (alpha=0), matching the
//      WebGL CLAMP_TO_EDGE + the corners-inside-image expectation —
//      the editor's UI clamps drag handles to the image rect, so
//      corners are always within bounds at op-emit time.

import { computeHomography, invertMatrix3, perspectiveOutputSize } from './canvas-math.ts';

export interface PerspectiveResult {
  buffer: Buffer;
  width: number;
  height: number;
}

/** Apply a perspective op to a raw RGBA pixel buffer. Returns the
 * rectified output buffer + dimensions, or null when the op's
 * corners are malformed / produce a singular homography. */
export function resamplePerspective(
  src: Buffer,
  srcW: number,
  srcH: number,
  op: { corners?: unknown }
): PerspectiveResult | null {
  const corners = parseCorners(op);
  if (!corners) return null;
  const { w: outW, h: outH } = perspectiveOutputSize(corners);
  // Map the user-picked source corners to the output rectangle
  // (0,0)-(outW,outH). H goes src→dst; sampling wants dst→src.
  const H = computeHomography(corners, [
    [0, 0],
    [outW, 0],
    [outW, outH],
    [0, outH]
  ]);
  if (!H) return null;
  const Hinv = invertMatrix3(H);
  if (!Hinv) return null;

  const out = new Uint8Array(outW * outH * 4);
  const m0 = Hinv[0] as number;
  const m1 = Hinv[1] as number;
  const m2 = Hinv[2] as number;
  const m3 = Hinv[3] as number;
  const m4 = Hinv[4] as number;
  const m5 = Hinv[5] as number;
  const m6 = Hinv[6] as number;
  const m7 = Hinv[7] as number;
  const m8 = Hinv[8] as number;
  const maxSrcX = srcW - 1;
  const maxSrcY = srcH - 1;
  for (let y = 0; y < outH; y++) {
    // The (Hinv * [x, y, 1]) numerator + denominator both have a
    // term that depends only on y. Hoist them out of the inner
    // loop — ~20% speedup on a 3200×2400 sample.
    const ny0 = m1 * y + m2;
    const ny1 = m4 * y + m5;
    const dy = m7 * y + m8;
    let oi = y * outW * 4;
    for (let x = 0; x < outW; x++) {
      const denom = m6 * x + dy;
      // Degenerate denominator (point at infinity) → transparent.
      if (denom === 0) {
        out[oi] = 0;
        out[oi + 1] = 0;
        out[oi + 2] = 0;
        out[oi + 3] = 0;
        oi += 4;
        continue;
      }
      const sx = (m0 * x + ny0) / denom;
      const sy = (m3 * x + ny1) / denom;
      if (sx < 0 || sx > maxSrcX || sy < 0 || sy > maxSrcY) {
        out[oi] = 0;
        out[oi + 1] = 0;
        out[oi + 2] = 0;
        out[oi + 3] = 0;
        oi += 4;
        continue;
      }
      // Bilinear: lerp the 4 surrounding texels.
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = x0 < maxSrcX ? x0 + 1 : x0;
      const y1 = y0 < maxSrcY ? y0 + 1 : y0;
      const fx = sx - x0;
      const fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;
      out[oi] =
        (src[i00] as number) * w00 +
        (src[i10] as number) * w10 +
        (src[i01] as number) * w01 +
        (src[i11] as number) * w11;
      out[oi + 1] =
        (src[i00 + 1] as number) * w00 +
        (src[i10 + 1] as number) * w10 +
        (src[i01 + 1] as number) * w01 +
        (src[i11 + 1] as number) * w11;
      out[oi + 2] =
        (src[i00 + 2] as number) * w00 +
        (src[i10 + 2] as number) * w10 +
        (src[i01 + 2] as number) * w01 +
        (src[i11 + 2] as number) * w11;
      out[oi + 3] =
        (src[i00 + 3] as number) * w00 +
        (src[i10 + 3] as number) * w10 +
        (src[i01 + 3] as number) * w01 +
        (src[i11 + 3] as number) * w11;
      oi += 4;
    }
  }
  return { buffer: Buffer.from(out.buffer), width: outW, height: outH };
}

type Corner = readonly [number, number];
type CornerQuad = readonly [Corner, Corner, Corner, Corner];

function parseCorners(op: { corners?: unknown }): CornerQuad | null {
  const c = op.corners;
  if (!Array.isArray(c) || c.length !== 4) return null;
  const out: Corner[] = [];
  for (const p of c) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push([x, y]);
  }
  return out as unknown as CornerQuad;
}
