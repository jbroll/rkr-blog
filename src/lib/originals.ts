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

import { readPersistedSiteConfig } from './config.ts';
import { FORMAT_TO_EXT, SHARP_INGEST_PIXEL_LIMIT } from './image-constants.ts';
import type { ResizeResult } from './ingest-resize.ts';
import { resizeAndEncode } from './ingest-resize.ts';
import { read as sidecarRead, write as sidecarWrite } from './sidecar.ts';
import type { Sidecar, SidecarResizeRecord } from './sidecar-types.ts';

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

interface IngestSource {
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
  /** Skip the ingest-time resize/re-encode AND the EXIF orientation
   * bake — write the upload bytes to disk byte-identical. Set by the
   * WordPress importer so archive content from an existing blog isn't
   * generation-2 lossy-recompressed. Not exposed to interactive
   * uploads (admin, URL import, gdrive, onedrive). */
  passthrough?: boolean;
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
  now,
  passthrough
}: IngestArgs): Promise<IngestResult> {
  // Operator-tuned defaults from /admin/settings live in
  // <siteRoot>/config/site.json. Read it via the siteRoot arg rather
  // than siteConfig()'s env-driven default, so an ingest into a tmp
  // siteRoot (tests, multi-site harnesses) picks up the JSON sitting
  // next to it. Undefined → resizeAndEncode uses its compile-time
  // defaults. No per-request override — this is the only knob.
  const persistedResize = readPersistedSiteConfig({
    ...process.env,
    SITE_ROOT: siteRoot
  }).ingestResize;
  const tmpDir = path.join(siteRoot, 'originals', '.tmp');
  await fs.promises.mkdir(tmpDir, { recursive: true });

  let tmpPath = path.join(tmpDir, `ingest-${crypto.randomBytes(8).toString('hex')}.bin`);
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
    meta = await sharp(tmpPath, {
      limitInputPixels: SHARP_INGEST_PIXEL_LIMIT,
      failOn: 'error'
    }).metadata();
  } catch (err) {
    await safeUnlink(tmpPath);
    throw new Error(`ingestStream: not a recognized image: ${(err as Error).message}`);
  }

  // Decompression-bomb guard for ingest uploads. Sharp's
  // limitInputPixels throws on actual decode; metadata() may return
  // dimensions without decoding, so cross-check explicitly. We use
  // the ingest ceiling (200 Mpx) here rather than SHARP_PIXEL_LIMIT
  // because the whole point of ingest-resize is to accept large
  // camera/HEIC uploads and shrink them — anything above the ingest
  // ceiling is presumed pathological.
  const uploadW = meta.width ?? 0;
  const uploadH = meta.height ?? 0;
  // SVG has no intrinsic pixel count; skip the dimension guard.
  if (meta.format !== 'svg' && uploadW * uploadH > SHARP_INGEST_PIXEL_LIMIT) {
    await safeUnlink(tmpPath);
    throw new Error(`ingestStream: image too large (${uploadW}x${uploadH} pixels exceeds limit)`);
  }

  const uploadFormat = meta.format;
  if (!uploadFormat || !FORMAT_TO_EXT[uploadFormat]) {
    await safeUnlink(tmpPath);
    throw new Error(`ingestStream: unsupported image format ${String(uploadFormat)}`);
  }

  // Dedup: probe every ext the resize step could plausibly land on.
  // Pre-feature originals (.jpg, .png, .heif, etc.) are honored too —
  // we don't re-process bytes that already live on disk.
  const existingOriginal = await findExistingOriginal(siteRoot, id);

  let ext: string;
  let finalPath: string;
  let deduplicated = false;
  let resizeRecord: SidecarResizeRecord | undefined;
  let storedHash: string | undefined;

  if (existingOriginal) {
    deduplicated = true;
    ext = existingOriginal.ext;
    finalPath = existingOriginal.path;
    await safeUnlink(tmpPath);
  } else if (passthrough) {
    // WordPress importer path: keep upload bytes byte-identical on
    // disk. Skip orientation bake + resize/re-encode entirely. Trades
    // EXIF-orientation correctness for archive fidelity — the WP
    // importer's job is to mirror an existing blog, not to "improve"
    // images that already went through a render pipeline at the
    // source.
    ext = FORMAT_TO_EXT[uploadFormat] as string;
    const finalDir = path.join(siteRoot, 'originals', id.slice(0, 2), id.slice(2, 4));
    finalPath = path.join(finalDir, `${id}.${ext}`);
    await fs.promises.mkdir(finalDir, { recursive: true });
    await fs.promises.rename(tmpPath, finalPath);
    storedHash = id; // upload bytes == on-disk bytes, so storedHash == id
    resizeRecord = {
      applied: false,
      reason: 'import-passthrough',
      encoding: 'passthrough'
    };
  } else {
    // Normalize EXIF Orientation so on-disk pixels match display orientation.
    // Phone portraits typically arrive as encoded landscape with orientation=6
    // ("rotate 90° CW for display"); we re-encode here so every downstream
    // reader (render pipeline, dimension-aware layout, editor preview) can
    // ignore EXIF entirely. Sharp 0.33 has a "one rotate per pipeline"
    // constraint that prevents chaining auto-orient with editor rotate ops,
    // so baking on ingest is the only composable place for this work.
    // Must run BEFORE resize: resize otherwise clamps the wrong axis on
    // portrait phone JPEGs (encoded landscape + orientation=6).
    if (meta.orientation && meta.orientation > 1) {
      const uploadExt = FORMAT_TO_EXT[uploadFormat] ?? 'bin';
      const normTmp = `${tmpPath}.norm.${uploadExt}`;
      try {
        await sharp(tmpPath, { limitInputPixels: SHARP_INGEST_PIXEL_LIMIT, failOn: 'error' })
          .rotate()
          .toFile(normTmp);
      } catch (err) {
        await safeUnlink(tmpPath);
        await safeUnlink(normTmp);
        throw new Error(
          `ingestStream: orientation normalization failed: ${(err as Error).message}`
        );
      }
      await safeUnlink(tmpPath);
      await fs.promises.rename(normTmp, tmpPath);
      meta = await sharp(tmpPath, {
        limitInputPixels: SHARP_INGEST_PIXEL_LIMIT,
        failOn: 'error'
      }).metadata();
    }

    let resized: ResizeResult;
    try {
      resized = await resizeAndEncode({
        inputPath: tmpPath,
        meta,
        tmpDir,
        ...(persistedResize ? { options: persistedResize } : {})
      });
    } catch (err) {
      await safeUnlink(tmpPath);
      throw new Error(`ingestStream: resize failed: ${(err as Error).message}`);
    }

    // Resize wrote to a fresh tmp file; drop the orientation-normalized
    // upload and adopt the resized bytes as the staged tmp.
    await safeUnlink(tmpPath);
    tmpPath = resized.outPath;
    ext = resized.ext;
    storedHash = resized.storedHash;
    resizeRecord = {
      applied: resized.reason === 'resized',
      reason: resized.reason,
      maxDim: resized.applied.maxDim,
      scalePct: resized.applied.scalePct,
      webpQuality: resized.applied.webpQuality,
      encoding: resized.encoding
    };

    const finalDir = path.join(siteRoot, 'originals', id.slice(0, 2), id.slice(2, 4));
    finalPath = path.join(finalDir, `${id}.${ext}`);
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
      const sidecarSource: Sidecar['source'] = {
        ...source,
        fetched,
        uploadFormat,
        uploadWidth: uploadW,
        uploadHeight: uploadH,
        uploadBytes: bytes
      };
      if (storedHash) sidecarSource.storedHash = storedHash;
      if (resizeRecord) sidecarSource.resize = resizeRecord;

      // No metadata field: dimensions + format come from the file via
      // imageInfo() at lookup time. The file IS the truth.
      const fresh: Sidecar = {
        version: 1,
        original: id,
        source: sidecarSource,
        ops: [],
        outputs: DEFAULT_OUTPUTS,
        variants: DEFAULT_VARIANTS
      };
      await sidecarWrite(siteRoot, id, fresh);
      return fresh;
    })());

  return { id, path: finalPath, ext, bytes, deduplicated, sidecar };
}

/** Probe the originals shard for any extension a prior ingest could
 * have produced. Returns the first hit, or undefined if the id is
 * fresh. Probed exts cover both the post-feature outputs (webp / gif
 * passthrough / svg passthrough) and pre-feature uploads (jpg / png /
 * heif / tiff / avif) so dedup honors legacy files too. */
async function findExistingOriginal(
  siteRoot: string,
  id: string
): Promise<{ path: string; ext: string } | undefined> {
  const dir = path.join(siteRoot, 'originals', id.slice(0, 2), id.slice(2, 4));
  const candidates = ['webp', 'gif', 'svg', 'jpg', 'png', 'heif', 'tiff', 'avif'];
  for (const ext of candidates) {
    const p = path.join(dir, `${id}.${ext}`);
    if (await exists(p)) return { path: p, ext };
  }
  return undefined;
}

/** Resolve the on-disk original for an id and read its sharp.metadata.
 * The file IS the source of truth for dimensions + format; recording
 * those on the sidecar invites synchronization bugs. Returns null
 * when the id isn't on disk (caller decides whether that's an error).
 *
 * Used by:
 *   - validateOps callers (crop-bounds check needs width/height)
 *   - GET /admin/sidecar/:id/meta (returns dims + format to the editor)
 *   - admin-image-lookup, admin-post-bundle (need ext for the served
 *     filename + Content-Type)
 *   - cli/verify (checks ext is a recognized format)
 *
 * @public */
export async function imageInfo(
  siteRoot: string,
  id: string
): Promise<{
  path: string;
  ext: string;
  format: string | null;
  width: number | null;
  height: number | null;
} | null> {
  const found = await findExistingOriginal(siteRoot, id);
  if (!found) return null;
  try {
    const meta = await sharp(found.path).metadata();
    return {
      path: found.path,
      ext: found.ext,
      format: meta.format ?? null,
      width: meta.width ?? null,
      height: meta.height ?? null
    };
  } catch {
    /* c8 ignore start -- undecodable file on disk shouldn't happen for
       ingested originals; surface a partial result so callers can
       still report "image present but unreadable" */
    return { path: found.path, ext: found.ext, format: null, width: null, height: null };
    /* c8 ignore stop */
  }
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
