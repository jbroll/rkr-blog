// Streaming ingest of an image into originals/ + sidecars/.
// Hash-while-stream so we never have to re-read the bytes off disk.
//
// On-disk layout per implementation.md §3:
//   originals/<id[0:2]>/<id[2:4]>/<id>.<ext>
//
// Sharp determines the authoritative format from bytes (not the client's
// claimed filename), and supplies width/height for the sidecar metadata.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';

import { FORMAT_TO_EXT, SHARP_PIXEL_LIMIT } from './image-constants.ts';
import { type Sidecar, read as sidecarRead, write as sidecarWrite } from './sidecar.ts';

// Re-export so callers that historically imported FORMAT_TO_EXT from
// originals.ts continue to work (notably routes/admin.ts).
export { FORMAT_TO_EXT };

// Default derivative set on first ingest. Matches the image widget
// defaults (spec.md §5 sidecar schema). Caller can rewrite via POST
// /admin/sidecar/:id.
// These constants are exported and asserted by
// test/lib/widget-fallback-alignment.test.ts to guarantee every
// (variant, output) the rendered HTML references in <img src> /
// <source srcset> is one the sidecar actually declares — otherwise
// findVariantOutput in routes/public.ts can't reproduce the cacheKey
// and /img/ 404s with "no matching variant".
//
// The union covers every src-emitting widget (image, carousel,
// diptych, gallery): widths 320/400/640/800/1200/1600, formats
// webp@85 + avif@70 (srcset sources) and jpeg@85 (the <img>
// fallback for browsers without webp/avif support).
export const DEFAULT_OUTPUTS = [
  { format: 'webp', quality: 85 },
  { format: 'avif', quality: 70 },
  { format: 'jpeg', quality: 85 }
];
export const DEFAULT_VARIANTS = [
  { w: 320 }, // diptych/gallery srcset
  { w: 400 }, // image/carousel srcset
  { w: 640 }, // diptych/gallery srcset
  { w: 800 }, // image/carousel srcset + diptych/gallery fallback
  { w: 1200 }, // image/carousel fallback + diptych/gallery srcset
  { w: 1600 } // image/carousel srcset
];

export interface IngestSource {
  kind: string;
  originalName?: string | null;
  // Provider-specific fields (e.g. fileId for gdrive) are allowed.
  [k: string]: unknown;
}

export interface IngestArgs {
  stream: Readable;
  siteRoot: string;
  /** Sidecar source block sans `fetched`; the caller's kind/originalName/etc. */
  source: IngestSource;
  /** Override timestamp for tests; default new Date().toISOString(). */
  now?: string;
}

export interface IngestResult {
  id: string;
  path: string;
  ext: string;
  bytes: number;
  deduplicated: boolean;
  sidecar: Sidecar;
}

/** Ingest a Readable byte stream into the site's originals + sidecars trees. */
export async function ingestStream({
  stream,
  siteRoot,
  source,
  now
}: IngestArgs): Promise<IngestResult> {
  const tmpDir = path.join(siteRoot, 'originals', '.tmp');
  await fs.promises.mkdir(tmpDir, { recursive: true });

  const tmpPath = path.join(tmpDir, `ingest-${crypto.randomBytes(8).toString('hex')}.bin`);
  const hasher = crypto.createHash('sha256');
  let bytes = 0;

  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hasher.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    }
  });

  try {
    await pipeline(stream, tap, fs.createWriteStream(tmpPath));
  } catch (err) {
    await safeUnlink(tmpPath);
    throw err;
  }

  const id = hasher.digest('hex');

  let meta: sharp.Metadata;
  try {
    meta = await sharp(tmpPath, { limitInputPixels: SHARP_PIXEL_LIMIT }).metadata();
  } catch (err) {
    await safeUnlink(tmpPath);
    throw new Error(`ingestStream: not a recognized image: ${(err as Error).message}`);
  }

  // Reject decompression-bomb inputs early. Sharp's limitInputPixels
  // throws on actual decode but metadata() may return dimensions without
  // decoding; cross-check.
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w * h > SHARP_PIXEL_LIMIT) {
    await safeUnlink(tmpPath);
    throw new Error(`ingestStream: image too large (${w}x${h} pixels exceeds limit)`);
  }

  const ext = meta.format ? FORMAT_TO_EXT[meta.format] : undefined;
  if (!ext) {
    await safeUnlink(tmpPath);
    throw new Error(`ingestStream: unsupported image format ${String(meta.format)}`);
  }

  const finalDir = path.join(siteRoot, 'originals', id.slice(0, 2), id.slice(2, 4));
  const finalPath = path.join(finalDir, `${id}.${ext}`);

  let deduplicated = false;
  if (await exists(finalPath)) {
    deduplicated = true;
    await safeUnlink(tmpPath);
  } else {
    // Normalize EXIF Orientation so on-disk pixels match display orientation.
    // Phone portraits typically arrive as encoded landscape with orientation=6
    // ("rotate 90° CW for display"); we re-encode here so every downstream
    // reader (render pipeline, dimension-aware layout, editor preview) can
    // ignore EXIF entirely. Sharp 0.33 has a "one rotate per pipeline"
    // constraint that prevents chaining auto-orient with editor rotate ops,
    // so baking on ingest is the only composable place for this work.
    // Re-encoding is lossy but only runs on the write path — dedup hits
    // skip it.
    if (meta.orientation && meta.orientation > 1) {
      const normTmp = `${tmpPath}.norm.${ext}`;
      try {
        await sharp(tmpPath, { limitInputPixels: SHARP_PIXEL_LIMIT }).rotate().toFile(normTmp);
      } catch (err) {
        await safeUnlink(tmpPath);
        await safeUnlink(normTmp);
        throw new Error(
          `ingestStream: orientation normalization failed: ${(err as Error).message}`
        );
      }
      await safeUnlink(tmpPath);
      await fs.promises.rename(normTmp, tmpPath);
      meta = await sharp(tmpPath, { limitInputPixels: SHARP_PIXEL_LIMIT }).metadata();
    }
    await fs.promises.mkdir(finalDir, { recursive: true });
    await fs.promises.rename(tmpPath, finalPath);
  }

  const fetched = now ?? new Date().toISOString();

  // Reuse the existing sidecar if present (dedupe path) to preserve user
  // edits to ops/outputs/variants. Only create one when none exists.
  const existing = await sidecarRead(siteRoot, id);
  const sidecar: Sidecar =
    existing ??
    (await (async (): Promise<Sidecar> => {
      const fresh: Sidecar = {
        version: 1,
        original: id,
        source: { ...source, fetched },
        metadata: pickMetadata(meta),
        ops: [],
        outputs: DEFAULT_OUTPUTS,
        variants: DEFAULT_VARIANTS
      };
      await sidecarWrite(siteRoot, id, fresh);
      return fresh;
    })());

  return { id, path: finalPath, ext, bytes, deduplicated, sidecar };
}

function pickMetadata(meta: sharp.Metadata): Sidecar['metadata'] {
  // Sharp returns exif as a Buffer; defer parsing until needed (Step 3+).
  // Keep the sidecar JSON-safe by omitting raw buffers here. By the time
  // ingestStream calls this, EXIF Orientation has been baked into pixels
  // (see the orientation > 1 branch above), so width/height already match
  // display orientation.
  return {
    width: meta.width,
    height: meta.height,
    format: meta.format
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fs.promises.unlink(p);
  } catch {
    /* already gone */
  }
}

export function originalPath(siteRoot: string, id: string, ext: string): string {
  return path.join(siteRoot, 'originals', id.slice(0, 2), id.slice(2, 4), `${id}.${ext}`);
}

/** Path for the client-baked post-ops image. The bake is the canvas
 * pipeline's final output for the current sidecar.ops, uploaded by the
 * editor right after each ops mutation. The render pipeline prefers it
 * over the original when present (skips re-applying ops in sharp).
 *
 * Always WebP: camera photos compress ~10x better than PNG at q=0.95
 * with no perceptible quality loss; WebP also supports lossless if a
 * future caller wants to preserve text-crisp graphics. Same 2/2 prefix
 * nesting as originals so we don't dump 10k files in one directory. */
export function bakePath(siteRoot: string, id: string): string {
  return path.join(siteRoot, 'bakes', id.slice(0, 2), id.slice(2, 4), `${id}.webp`);
}
