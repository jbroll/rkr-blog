// Validate + normalize the `ops` array for POST /admin/sidecar/:id/ops.
// Pure — no FS, no async — so the server route AND the client editor
// share the exact same normalization. That symmetry matters: the
// server stores `validation.ops` (Math.floor on crop/resample, mod
// 360 on rotate, default fit:'inside', no-op rotations dropped), and
// the bake's X-Rkr-Bake-Ops-Hash is computed over canonical(sidecar.ops).
// If the client hashes pre-normalization ops while the server hashes
// post-normalization ops, every bake of a canvas-driven crop
// (subpixel float coords) systematically 409s even single-tab.
// Shared module = same normalization = matching hashes by construction.

import { type Point, perspectiveOutputSize } from './canvas-math.ts';
import { SHARP_PIXEL_LIMIT } from './image-constants.ts';
import { inscribedRect } from './rotation.ts';
import type { SidecarOp } from './sidecar-types.ts';

/** Maximum ops in a sidecar. Caps the chain depth a single editor save
 * can install — defends against a malicious / runaway client building
 * a million-step pipeline that the renderer would have to execute. */
const MAX_OPS = 8;

/** Cap on a resample target dimension. Above this we'd be asking sharp
 * to bake a derivative larger than any realistic display, and approach
 * the SHARP_PIXEL_LIMIT from the original axis. */
const MAX_RESAMPLE_PX = 8000;

/** Cap on any single perspective corner coord. Practical pipeline
 * canvases top out around 50 Mpx (the SHARP_PIXEL_LIMIT) so a coord
 * 100k pixels on a side is well past anything legitimate; this exists
 * to refuse runaway values from a buggy or malicious client up front. */
const MAX_PERSPECTIVE_COORD = 100_000;

const VALID_FITS = new Set(['inside', 'outside', 'cover', 'contain', 'fill']);

interface ValidatedOps {
  ok: true;
  ops: SidecarOp[];
}
type OpsValidation = ValidatedOps | { ok: false; error: string };

/**
 * Validate the body's `ops` array and clamp it against the source's
 * actual pixel bounds. Supports the four edit ops the renderer knows
 * about: crop, rotate, flip, resample, plus the client-only
 * perspective rectify (shape-validated; pixel work is done by the
 * canvas pipeline and the result is uploaded as the bake).
 */
export function validateOps(
  raw: unknown,
  metadata: { width?: number; height?: number }
): OpsValidation {
  if (!Array.isArray(raw)) return { ok: false, error: 'ops must be an array' };
  if (raw.length > MAX_OPS) return { ok: false, error: `at most ${MAX_OPS} ops` };

  const W = metadata.width ?? 0;
  const H = metadata.height ?? 0;
  // Without source dimensions we can't sanity-check crop bounds.
  // Silently accepting would let an authored op produce an
  // unrenderable sidecar (sharp.extract throws) — every /img request
  // that hits this id then 500s. Refuse non-empty op lists in that
  // case; an empty array (clear all ops) is still allowed.
  if (raw.length > 0 && (W <= 0 || H <= 0)) {
    return { ok: false, error: 'source has no recorded dimensions; cannot validate ops' };
  }

  // Track running canvas dimensions so crop bounds are validated
  // against the actual current size (post-rotate/flip/prior-crop),
  // not just the original.  flip never changes dimensions; resample
  // sets them to the exact floor values it produces; rotate 90/270
  // swaps W↔H; rotate 180 leaves them unchanged.
  let curW = W;
  let curH = H;

  const out: { type: string; [k: string]: unknown }[] = [];
  for (const [i, opRaw] of raw.entries()) {
    if (!opRaw || typeof opRaw !== 'object') {
      return { ok: false, error: `ops[${i}] must be an object` };
    }
    const op = opRaw as Record<string, unknown>;
    const type = op.type;
    if (type === 'crop') {
      const x = Number(op.x);
      const y = Number(op.y);
      const w = Number(op.w);
      const h = Number(op.h);
      if (![x, y, w, h].every(Number.isFinite)) {
        return { ok: false, error: `ops[${i}] crop must have numeric x/y/w/h` };
      }
      if (x < 0 || y < 0 || w <= 0 || h <= 0) {
        return { ok: false, error: `ops[${i}] crop must have x/y >= 0 and w/h > 0` };
      }
      // Floor before bounds-checking: CropperJS emits subpixel floats
      // (e.g. w=100.5 on a 100px canvas). Checking raw floats rejects
      // what would be a valid floor-truncated crop.
      const nx = Math.floor(x);
      const ny = Math.floor(y);
      const nw = Math.floor(w);
      const nh = Math.floor(h);
      if (nw <= 0 || nh <= 0) {
        return { ok: false, error: `ops[${i}] crop w/h must round to > 0` };
      }
      if (curW > 0 && curH > 0 && (nx + nw > curW || ny + nh > curH)) {
        return {
          ok: false,
          error: `ops[${i}] crop ${nx},${ny} ${nw}x${nh} exceeds source ${curW}x${curH}`
        };
      }
      out.push({ type: 'crop', x: nx, y: ny, w: nw, h: nh });
      curW = nw;
      curH = nh;
    } else if (type === 'rotate') {
      const degrees = Number(op.degrees ?? 0);
      if (!Number.isFinite(degrees)) {
        return { ok: false, error: `ops[${i}] rotate degrees must be a finite number` };
      }
      const norm = ((degrees % 360) + 360) % 360;
      if (norm === 0) continue; // no-op; drop silently
      out.push({ type: 'rotate', degrees: norm });
      if (norm === 90 || norm === 270) {
        [curW, curH] = [curH, curW];
      } else if (norm !== 180) {
        const { iw, ih } = inscribedRect(curW, curH, norm);
        curW = iw;
        curH = ih;
      }
    } else if (type === 'flip') {
      const axis = op.axis;
      if (axis !== 'horizontal' && axis !== 'vertical') {
        return { ok: false, error: `ops[${i}] flip axis must be 'horizontal' or 'vertical'` };
      }
      out.push({ type: 'flip', axis });
    } else if (type === 'resample') {
      const w = op.w !== undefined ? Number(op.w) : undefined;
      const h = op.h !== undefined ? Number(op.h) : undefined;
      if (w === undefined && h === undefined) {
        return { ok: false, error: `ops[${i}] resample needs at least w or h` };
      }
      for (const [name, v] of [
        ['w', w],
        ['h', h]
      ] as const) {
        if (v === undefined) continue;
        if (!Number.isFinite(v) || v <= 0) {
          return { ok: false, error: `ops[${i}] resample ${name} must be > 0` };
        }
        if (v > MAX_RESAMPLE_PX) {
          return {
            ok: false,
            error: `ops[${i}] resample ${name} must be <= ${MAX_RESAMPLE_PX}`
          };
        }
      }
      const fitRaw = op.fit;
      const fit =
        typeof fitRaw === 'string' && VALID_FITS.has(fitRaw) ? (fitRaw as string) : 'inside';
      const norm: { type: 'resample'; w?: number; h?: number; fit: string } = {
        type: 'resample',
        fit
      };
      if (w !== undefined) norm.w = Math.floor(w);
      if (h !== undefined) norm.h = Math.floor(h);
      out.push(norm);
      // Update running dims for the resample: sharp's 'inside' (default)
      // scales to fit within the target box preserving aspect ratio.
      // Track the exact floor values so a subsequent crop sees the real
      // post-resample canvas size.
      if (norm.w !== undefined && norm.h !== undefined) {
        curW = norm.w;
        curH = norm.h;
      } else if (norm.w !== undefined) {
        curH = curH > 0 ? Math.floor((curH * norm.w) / curW) : norm.w;
        curW = norm.w;
      } else if (norm.h !== undefined) {
        curW = curW > 0 ? Math.floor((curW * norm.h) / curH) : norm.h;
        curH = norm.h;
      }
    } else if (type === 'perspective') {
      // Perspective rectify is a client-only execution path: the
      // canvas pipeline produces the rectified result and uploads it
      // as the bake. Sharp doesn't apply perspective ops; if a render
      // request hits a sidecar with perspective in ops AND the bake is
      // missing, renderDerivative will error out. Validate shape only.
      const corners = op.corners;
      if (!Array.isArray(corners) || corners.length !== 4) {
        return { ok: false, error: `ops[${i}] perspective corners must be an array of 4 points` };
      }
      const normCorners: [number, number][] = [];
      for (let k = 0; k < 4; k++) {
        const c = corners[k];
        if (!Array.isArray(c) || c.length !== 2) {
          return {
            ok: false,
            error: `ops[${i}] perspective corners[${k}] must be a [x, y] pair`
          };
        }
        const x = Number(c[0]);
        const y = Number(c[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return {
            ok: false,
            error: `ops[${i}] perspective corners[${k}] must be finite numbers`
          };
        }
        if (x < 0 || y < 0) {
          return {
            ok: false,
            error: `ops[${i}] perspective corners[${k}] must be non-negative`
          };
        }
        if (x > MAX_PERSPECTIVE_COORD || y > MAX_PERSPECTIVE_COORD) {
          return {
            ok: false,
            error: `ops[${i}] perspective corners[${k}] must be <= ${MAX_PERSPECTIVE_COORD}`
          };
        }
        normCorners.push([Math.round(x), Math.round(y)]);
      }
      const [pc0, pc1, pc2, pc3] = normCorners;
      const { w: outW, h: outH } = perspectiveOutputSize([pc0, pc1, pc2, pc3] as [
        Point,
        Point,
        Point,
        Point
      ]);
      if (outW * outH > SHARP_PIXEL_LIMIT) {
        return {
          ok: false,
          error: `ops[${i}] perspective output ${outW}x${outH} exceeds the ${SHARP_PIXEL_LIMIT / 1_000_000} Mpx area limit`
        };
      }
      out.push({ type: 'perspective', corners: normCorners });
    } else {
      return {
        ok: false,
        error: `ops[${i}].type must be 'crop' | 'rotate' | 'flip' | 'resample' | 'perspective' (got ${String(type)})`
      };
    }
  }
  return { ok: true, ops: out };
}
