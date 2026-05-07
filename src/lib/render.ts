// Image derivative renderer. Pure modulo filesystem writes:
// same args → same on-disk path → same bytes (assuming a stable libvips).
// See spec §11.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

import { cacheKey } from './hash.ts';
import { originalPath } from './originals.ts';
import { read as sidecarRead } from './sidecar.ts';

/** Maximum pixel count any sharp pipeline will decode. Anti-DoS: caps
 * memory and CPU on a single render. 50 Mpx is comfortably above any
 * realistic camera sensor. */
export const SHARP_PIXEL_LIMIT = 50_000_000;

const FORMAT_TO_EXT: Record<string, string | undefined> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  gif: 'gif',
  tiff: 'tiff',
  heif: 'heif'
};

export type OutputFormat = 'webp' | 'avif' | 'jpeg' | 'png';

export interface CropOp {
  type: 'crop';
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ResampleOp {
  type: 'resample';
  w?: number;
  h?: number;
  fit?: 'inside' | 'outside' | 'cover' | 'contain' | 'fill';
}

export interface RotateOp {
  type: 'rotate';
  degrees?: number;
}

/** Mirror across an axis. `horizontal` flips left↔right (sharp.flop),
 * `vertical` flips top↔bottom (sharp.flip). We normalise the naming
 * because sharp's flip/flop API is famously easy to confuse. */
export interface FlipOp {
  type: 'flip';
  axis: 'horizontal' | 'vertical';
}

export type Op = CropOp | ResampleOp | RotateOp | FlipOp;

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

  // Cache miss: locate the original via the sidecar and run the pipeline.
  const sidecar = await sidecarRead(siteRoot, originalId);
  if (!sidecar) {
    throw new Error(`renderDerivative: no sidecar for ${originalId}`);
  }
  const fmt = sidecar.metadata.format;
  const ext = fmt ? FORMAT_TO_EXT[fmt] : undefined;
  if (!ext) {
    throw new Error(`renderDerivative: unsupported original format ${String(fmt)}`);
  }
  const origPath = originalPath(siteRoot, originalId, ext);

  // Per spec §11: keep libvips threads from multiplying with job concurrency.
  sharp.concurrency(1);

  // Cap decoded pixel count to defend against decompression bombs — a
  // malicious 64Kpx-square WebP can decompress to gigabytes of memory.
  // 50 Mpx covers any realistic camera sensor; reject larger originals
  // up front. Mirror the same cap in originals.ingestStream.
  let pipeline = sharp(origPath, { failOn: 'error', limitInputPixels: SHARP_PIXEL_LIMIT });
  for (const op of ops) {
    pipeline = applyOp(pipeline, op);
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

function applyOp(p: sharp.Sharp, op: Op): sharp.Sharp {
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
    case 'rotate':
      return p.rotate(op.degrees ?? 0);
    case 'flip':
      // sharp.flip is vertical (top↔bottom); sharp.flop is horizontal
      // (left↔right). We expose `axis` instead of the flip/flop
      // shorthand to spare every reader the same five-second confusion.
      return op.axis === 'horizontal' ? p.flop() : p.flip();
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
