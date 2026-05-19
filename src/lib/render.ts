// Image derivative renderer. Pure modulo filesystem writes:
// same args → same on-disk path → same bytes (assuming a stable libvips).
// See spec.md §7 derivative rendering and implementation.md §5 image
// pipeline internals.
//
// Source-image precedence:
//   1. cache/img/<id>.<ophash>.<fmt>   — finished derivative (fast path).
//   2. bakes/<id>.webp                 — client-baked post-ops image,
//      uploaded by the editor after each ops mutation. When present we
//      skip applyOp and just downscale + encode for the variant.
//   3. originals/<id>.<ext>            — the master; sharp applies
//      every op before downscaling. Fallback for ids that never had a
//      bake uploaded (legacy data, batch imports, etc).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

import { cacheKey } from './hash.ts';
import { SHARP_PIXEL_LIMIT } from './image-constants.ts';
import { bakePath, imageInfo } from './originals.ts';
import { inscribedRect } from './rotation.ts';
import { read as sidecarRead } from './sidecar.ts';

export type OutputFormat = 'webp' | 'avif' | 'jpeg' | 'png';

interface CropOp {
  type: 'crop';
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ResampleOp {
  type: 'resample';
  w?: number;
  h?: number;
  fit?: 'inside' | 'outside' | 'cover' | 'contain' | 'fill';
}

interface RotateOp {
  type: 'rotate';
  degrees?: number;
}

/** Mirror across an axis. `horizontal` flips left↔right (sharp.flop),
 * `vertical` flips top↔bottom (sharp.flip). We normalise the naming
 * because sharp's flip/flop API is famously easy to confuse. */
interface FlipOp {
  type: 'flip';
  axis: 'horizontal' | 'vertical';
}

/** Perspective rectify op. Sharp can't apply a homography (Canvas2D
 * setTransform is affine only and libvips has no equivalent), so the
 * client bakes the result and uploads it; the renderer only ever sees
 * this op when sourcing from `originals/` as a fallback, in which case
 * applyOp throws and the request returns an error. The op is in the
 * union so the exhaustiveness check at applyOp's `default` branch is
 * a real type-level guarantee rather than a runtime-only string match. */
interface PerspectiveOp {
  type: 'perspective';
  corners: ReadonlyArray<readonly [number, number]>;
}

export type Op = CropOp | ResampleOp | RotateOp | FlipOp | PerspectiveOp;

export interface Variant {
  w?: number;
  h?: number;
  fit?: 'inside' | 'outside' | 'cover' | 'contain' | 'fill';
}

export interface Output {
  format: OutputFormat;
  quality?: number;
  effort?: number;
}

export interface DerivativeArgs {
  originalId: string;
  ops: Op[];
  variant: Variant;
  output: Output;
}

export interface RenderResult {
  path: string;
  bytes: number;
  cached: boolean;
}

/** Compute the cache filename for a derivative. */
export function derivativeFilename(args: DerivativeArgs): string {
  const oph = cacheKey({
    originalId: args.originalId,
    ops: args.ops as never,
    variant: args.variant as never,
    output: args.output as never
  });
  return `${args.originalId}.${oph}.${args.output.format}`;
}

export function derivativePath(siteRoot: string, args: DerivativeArgs): string {
  return path.join(siteRoot, 'cache', 'img', derivativeFilename(args));
}

/**
 * Render one derivative. Returns the on-disk path, byte length, and whether
 * the result was already in cache.
 *
 * `force: true` bypasses the cache-hit fast path; the existing cache file
 * will be atomically replaced.
 */
export async function renderDerivative(
  args: DerivativeArgs & { siteRoot: string; force?: boolean }
): Promise<RenderResult> {
  const { originalId, ops, variant, output, siteRoot, force = false } = args;
  const finalPath = derivativePath(siteRoot, { originalId, ops, variant, output });

  // Cache hit fast path: stat the file. Don't even import the original.
  if (!force) {
    try {
      const stat = await fs.promises.stat(finalPath);
      return { path: finalPath, bytes: stat.size, cached: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  // Cache miss: pick a source. Prefer the client-baked post-ops image
  // when present — its very existence means it was uploaded to match
  // the *current* sidecar.ops (the /admin/sidecar/:id/ops handler
  // unlinks any prior bake when ops change). Using it skips applyOp:
  // ops are already baked into the pixels.
  const baked = bakePath(siteRoot, originalId);
  const useBake = await fileExists(baked);
  let sourcePath: string;
  let origInfo: Awaited<ReturnType<typeof imageInfo>> = null;
  if (useBake) {
    sourcePath = baked;
  } else {
    const sidecar = await sidecarRead(siteRoot, originalId);
    if (!sidecar) {
      throw new Error(`renderDerivative: no sidecar for ${originalId}`);
    }
    // The file IS the source of truth for format; imageInfo finds it
    // by scanning candidate exts in originals/<aa>/<bb>/.
    origInfo = await imageInfo(siteRoot, originalId);
    if (!origInfo) {
      throw new Error(`renderDerivative: no original on disk for ${originalId}`);
    }
    sourcePath = origInfo.path;
  }

  // Keep libvips threads from multiplying with job concurrency
  // (implementation.md §5).
  sharp.concurrency(1);

  // Cap decoded pixel count to defend against decompression bombs — a
  // malicious 64Kpx-square WebP can decompress to gigabytes of memory.
  // 50 Mpx covers any realistic camera sensor; reject larger originals
  // up front. Mirror the same cap in originals.ingestStream.
  //
  // No EXIF auto-orient here: ingestStream normalizes orientation on
  // upload, so on-disk originals are already in display orientation.
  // (Sharp 0.33 has a "one rotate per pipeline" constraint that breaks
  // composition with editor rotate ops; baking on ingest sidesteps it.)
  let pipeline = sharp(sourcePath, { failOn: 'error', limitInputPixels: SHARP_PIXEL_LIMIT });
  // Only apply ops when sourcing from the original — the bake already
  // has them baked in.
  if (!useBake) {
    let curW = origInfo?.width ?? 0;
    let curH = origInfo?.height ?? 0;
    for (const op of ops) {
      pipeline = applyOp(pipeline, op, { w: curW, h: curH });
      ({ w: curW, h: curH } = nextDims(op, curW, curH));
    }
  }
  pipeline = applyVariant(pipeline, variant);
  pipeline = applyOutput(pipeline, output);

  await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
  const tmp = `${finalPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await pipeline.toFile(tmp);
    await fs.promises.rename(tmp, finalPath);
  } catch (err) {
    try {
      await fs.promises.unlink(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }

  const stat = await fs.promises.stat(finalPath);
  return { path: finalPath, bytes: stat.size, cached: false };
}

// ---- ops & output -------------------------------------------------------

function nextDims(op: Op, w: number, h: number): { w: number; h: number } {
  switch (op.type) {
    case 'crop':
      return { w: op.w, h: op.h };
    case 'rotate': {
      const norm = (((op.degrees ?? 0) % 360) + 360) % 360;
      if (norm === 90 || norm === 270) return { w: h, h: w };
      if (norm === 0 || norm === 180) return { w, h };
      const { iw, ih } = inscribedRect(w, h, norm);
      return { w: iw, h: ih };
    }
    case 'flip':
      return { w, h };
    case 'resample': {
      if (op.w !== undefined && op.h !== undefined) return { w: op.w, h: op.h };
      if (op.w !== undefined) return { w: op.w, h: h > 0 ? Math.floor((h * op.w) / w) : op.w };
      if (op.h !== undefined) return { w: w > 0 ? Math.floor((w * op.h) / h) : op.h, h: op.h };
      return { w, h };
    }
    case 'perspective':
      return { w, h };
  }
}

export function applyOp(
  p: sharp.Sharp,
  op: Op,
  dims: { w: number; h: number } = { w: 0, h: 0 }
): sharp.Sharp {
  switch (op.type) {
    case 'crop':
      return p.extract({ left: op.x, top: op.y, width: op.w, height: op.h });
    case 'resample':
      return p.resize({
        width: op.w,
        height: op.h,
        fit: op.fit ?? 'inside',
        withoutEnlargement: true
      });
    case 'rotate': {
      const norm = (((op.degrees ?? 0) % 360) + 360) % 360;
      if (norm === 0) return p;
      if (norm === 90 || norm === 180 || norm === 270) {
        return p.rotate(norm);
      }
      // Arbitrary angle: expand then extract inscribed rect.
      const { iw, ih, left, top } = inscribedRect(dims.w, dims.h, norm);
      return p
        .rotate(norm, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .extract({ left, top, width: iw, height: ih });
    }
    case 'flip':
      // sharp.flip is vertical (top↔bottom); sharp.flop is horizontal
      // (left↔right). We expose `axis` instead of the flip/flop
      // shorthand to spare every reader the same five-second confusion.
      return op.axis === 'horizontal' ? p.flop() : p.flip();
    case 'perspective':
      // Client-only op: the canvas pipeline produces the rectified
      // result and uploads it as the bake. Reaching this branch means
      // we sourced from `originals/` as a fallback (bake missing),
      // which we can't satisfy. Surface clearly so the operator can
      // re-bake rather than ship a derivative that ignored the op.
      throw new Error(
        'renderDerivative: perspective op requires a bake (run Save edits in the editor)'
      );
    default: {
      const exhaustive: never = op;
      throw new Error(`renderDerivative: unknown op type ${(exhaustive as Op).type}`);
    }
  }
}

function applyVariant(p: sharp.Sharp, variant: Variant): sharp.Sharp {
  if (variant.w == null && variant.h == null) return p;
  return p.resize({
    width: variant.w,
    height: variant.h,
    fit: variant.fit ?? 'inside',
    withoutEnlargement: true
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

function applyOutput(p: sharp.Sharp, output: Output): sharp.Sharp {
  switch (output.format) {
    case 'webp':
      return p.webp({ quality: output.quality ?? 85, effort: output.effort ?? 4 });
    case 'avif':
      return p.avif({ quality: output.quality ?? 70, effort: output.effort ?? 4 });
    case 'jpeg':
      return p.jpeg({ quality: output.quality ?? 85, mozjpeg: false });
    case 'png':
      return p.png({ compressionLevel: 6 });
    default: {
      const exhaustive: never = output.format;
      throw new Error(`renderDerivative: unknown output format ${String(exhaustive)}`);
    }
  }
}
