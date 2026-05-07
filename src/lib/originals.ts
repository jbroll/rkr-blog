// Streaming ingest of an image into originals/ + sidecars/.
// Hash-while-stream so we never have to re-read the bytes off disk.
//
// On-disk layout per spec §9:
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

import { SHARP_PIXEL_LIMIT } from './render.ts';
import {
  type Sidecar,
  sidecarPath,
  read as sidecarRead,
  write as sidecarWrite
} from './sidecar.ts';

const FORMAT_TO_EXT: Record<string, string | undefined> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  gif: 'gif',
  tiff: 'tiff',
  heif: 'heif'
};

// Default derivative set on first ingest. Matches the image widget defaults
// in spec §12. Caller can rewrite via POST /admin/sidecar/:id.
const DEFAULT_OUTPUTS = [
  { format: 'webp', quality: 85 },
  { format: 'avif', quality: 70 }
];
const DEFAULT_VARIANTS = [{ w: 400 }, { w: 800 }, { w: 1600 }];

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
  // Keep the sidecar JSON-safe by omitting raw buffers here.
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

export { sidecarPath };
