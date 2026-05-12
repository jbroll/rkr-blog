// Ingest-time downsample + re-encode.
//
// Called from lib/originals.ts after the upload stream has been
// hashed and (if needed) orientation-normalized, but before the bytes
// are renamed into their final shard. Replaces the on-disk master
// with a smaller, format-uniform representation:
//
//   JPEG / HEIC / WebP / TIFF → lossy WebP at webpQuality
//   PNG                       → lossless WebP (crisp screenshots,
//                               usually smaller than the PNG anyway)
//   Animated GIF (pages > 1)  → passthrough (don't animate-WebP)
//   SVG                       → passthrough (vector, no raster pixels)
//
// The render pipeline (lib/render.ts) reads originals/<id>.<ext> by
// looking up the actual ext from the sidecar, so the output ext can
// vary (webp | gif | svg) without breaking anything downstream.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

import {
  DEFAULT_INGEST_RESIZE,
  FORMAT_TO_EXT,
  INGEST_RESIZE_BOUNDS,
  SHARP_INGEST_PIXEL_LIMIT
} from './image-constants.ts';

interface ResizeOptions {
  /** Long-edge pixel cap. Image is shrunk so max(width,height) ≤ maxDim.
   * No upscaling regardless. Default DEFAULT_INGEST_RESIZE.maxDim. */
  maxDim?: number;
  /** Percentage scale applied after the maxDim clamp. 100 = no further
   * shrink. Default 100. */
  scalePct?: number;
  /** WebP encoder quality 1–100 for lossy outputs. Ignored for
   * lossless (PNG-input) and passthrough (animated-gif / svg).
   * Default 82. */
  webpQuality?: number;
}

type ResizeReason = 'gif-animated' | 'svg' | 'no-shrink-needed' | 'resized';
type ResizeEncoding = 'lossy' | 'lossless' | 'passthrough';

export interface ResizeResult {
  /** Absolute path of the output tmp file. Caller renames into shard. */
  outPath: string;
  /** Final on-disk format ('webp' for lossy/lossless, original for passthrough). */
  format: 'webp' | 'gif' | 'svg';
  /** File extension from FORMAT_TO_EXT for the final format. */
  ext: string;
  /** Post-resize dimensions of the bytes at outPath. */
  width: number;
  height: number;
  /** Bytes written to outPath. */
  bytes: number;
  /** SHA256 of the bytes at outPath. */
  storedHash: string;
  reason: ResizeReason;
  encoding: ResizeEncoding;
  /** Effective options after defaults + clamping. */
  applied: Required<ResizeOptions>;
}

export interface ResizeArgs {
  inputPath: string;
  meta: sharp.Metadata;
  tmpDir: string;
  options?: ResizeOptions;
}

/** Resize and/or re-encode an ingested image. See file header for the
 * format policy. Throws on encoder failure — the caller (ingestStream)
 * unlinks tmp files and surfaces the error. */
export async function resizeAndEncode(args: ResizeArgs): Promise<ResizeResult> {
  const { inputPath, meta, tmpDir } = args;
  const applied = resolveOptions(args.options);

  if (meta.format === 'svg') {
    return passthrough(inputPath, tmpDir, 'svg', 'svg', applied);
  }

  if (meta.format === 'gif' && (meta.pages ?? 1) > 1) {
    return passthrough(inputPath, tmpDir, 'gif', 'gif', applied);
  }

  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;
  /* c8 ignore next 3 -- sharp.metadata() always supplies dimensions for the
     raster formats this branch reaches; this guard is belt-and-braces */
  if (srcW <= 0 || srcH <= 0) {
    throw new Error(`resizeAndEncode: missing dimensions on input (format=${meta.format})`);
  }

  const longEdge = Math.max(srcW, srcH);
  const clamped = Math.min(longEdge, applied.maxDim);
  const target = Math.max(1, Math.round((clamped * applied.scalePct) / 100));
  const reason: ResizeReason = target >= longEdge ? 'no-shrink-needed' : 'resized';

  const encoding: ResizeEncoding = meta.format === 'png' ? 'lossless' : 'lossy';
  /* c8 ignore next 5 -- FORMAT_TO_EXT.webp is module-local in image-constants.ts;
     the lookup can't actually return undefined, but throwing beats trusting it */
  const ext = FORMAT_TO_EXT.webp;
  if (!ext) {
    throw new Error('resizeAndEncode: FORMAT_TO_EXT.webp missing');
  }

  const outPath = path.join(tmpDir, `resize-${crypto.randomBytes(8).toString('hex')}.${ext}`);

  const webpOptions =
    encoding === 'lossless' ? { lossless: true } : { quality: applied.webpQuality };

  await sharp(inputPath, { limitInputPixels: SHARP_INGEST_PIXEL_LIMIT })
    .resize({
      width: target,
      height: target,
      fit: 'inside',
      withoutEnlargement: true
    })
    .webp(webpOptions)
    .toFile(outPath);

  const outMeta = await sharp(outPath, { limitInputPixels: SHARP_INGEST_PIXEL_LIMIT }).metadata();
  const storedHash = await hashFile(outPath);
  const stat = await fs.promises.stat(outPath);

  return {
    outPath,
    format: 'webp',
    ext,
    width: outMeta.width ?? target,
    height: outMeta.height ?? target,
    bytes: stat.size,
    storedHash,
    reason,
    encoding,
    applied
  };
}

function resolveOptions(opts?: ResizeOptions): Required<ResizeOptions> {
  const maxDim = clamp(
    opts?.maxDim ?? DEFAULT_INGEST_RESIZE.maxDim,
    INGEST_RESIZE_BOUNDS.maxDim.min,
    INGEST_RESIZE_BOUNDS.maxDim.max
  );
  const scalePct = clamp(
    opts?.scalePct ?? DEFAULT_INGEST_RESIZE.scalePct,
    INGEST_RESIZE_BOUNDS.scalePct.min,
    INGEST_RESIZE_BOUNDS.scalePct.max
  );
  const webpQuality = clamp(
    opts?.webpQuality ?? DEFAULT_INGEST_RESIZE.webpQuality,
    INGEST_RESIZE_BOUNDS.webpQuality.min,
    INGEST_RESIZE_BOUNDS.webpQuality.max
  );
  return { maxDim, scalePct, webpQuality };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return Math.round(value);
}

async function passthrough(
  inputPath: string,
  tmpDir: string,
  format: 'gif' | 'svg',
  ext: 'gif' | 'svg',
  applied: Required<ResizeOptions>
): Promise<ResizeResult> {
  const outPath = path.join(tmpDir, `resize-${crypto.randomBytes(8).toString('hex')}.${ext}`);
  await fs.promises.copyFile(inputPath, outPath);
  const storedHash = await hashFile(outPath);
  const stat = await fs.promises.stat(outPath);

  let width = 0;
  let height = 0;
  if (format === 'gif') {
    const m = await sharp(outPath, { limitInputPixels: SHARP_INGEST_PIXEL_LIMIT }).metadata();
    width = m.width ?? 0;
    height = m.height ?? 0;
  } else {
    // SVG dimensions from sharp can be unreliable (viewBox vs px);
    // best-effort — the public render pipeline rasterizes SVG with
    // explicit width anyway.
    /* c8 ignore start -- only triggers on SVG inputs sharp can't introspect
       (no intrinsic size); test fixtures all carry width/height attrs */
    try {
      const m = await sharp(outPath).metadata();
      width = m.width ?? 0;
      height = m.height ?? 0;
    } catch {
      /* SVG without intrinsic size — leave at 0 */
    }
    /* c8 ignore stop */
  }

  return {
    outPath,
    format,
    ext,
    width,
    height,
    bytes: stat.size,
    storedHash,
    reason: format === 'gif' ? 'gif-animated' : 'svg',
    encoding: 'passthrough',
    applied
  };
}

async function hashFile(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}
