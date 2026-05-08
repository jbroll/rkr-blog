// Validate the body's `ops` array for POST /admin/sidecar/:id/ops.
// Pure — no FS, no async — so the route handler stays thin.
//
// Lives separately from src/routes/admin.ts to keep that file under
// the 500-line size cap.

import type { SidecarOp } from '../lib/sidecar-types.ts';

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
      if (W > 0 && H > 0 && (x + w > W || y + h > H)) {
        return {
          ok: false,
          error: `ops[${i}] crop ${x},${y} ${w}x${h} exceeds source ${W}x${H}`
        };
      }
      out.push({
        type: 'crop',
        x: Math.floor(x),
        y: Math.floor(y),
        w: Math.floor(w),
        h: Math.floor(h)
      });
    } else if (type === 'rotate') {
      const degrees = Number(op.degrees ?? 0);
      // Only orthogonal rotations make sense in our flow (the editor
      // emits ±90 multiples). Sharp accepts arbitrary angles, which
      // would force libvips to fill the corners — reject as
      // probably-wrong rather than render unexpectedly.
      if (!Number.isFinite(degrees) || degrees % 90 !== 0) {
        return { ok: false, error: `ops[${i}] rotate degrees must be a multiple of 90` };
      }
      const norm = ((degrees % 360) + 360) % 360;
      if (norm === 0) continue; // no-op rotation; drop silently
      out.push({ type: 'rotate', degrees: norm });
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
