// Streaming ingest of an image into originals/ + sidecars/.
// Hash-while-stream so we never have to re-read the bytes off disk.
//
// On-disk layout per spec §9:
//   originals/<id[0:2]>/<id[2:4]>/<id>.<ext>
//
// Sharp determines the authoritative format from bytes (not the client's
// claimed filename), and supplies width/height for the sidecar metadata.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import sharp from 'sharp';

import { write as sidecarWrite, read as sidecarRead, sidecarPath } from './sidecar.js';

const FORMAT_TO_EXT = {
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
const DEFAULT_VARIANTS = [
  { w: 400 }, { w: 800 }, { w: 1600 }
];

/**
 * Ingest a Readable byte stream into the site's originals + sidecars trees.
 *
 * @param {Object} args
 * @param {NodeJS.ReadableStream} args.stream
 * @param {string} args.siteRoot
 * @param {Object} args.source     - sidecar `source` block (e.g. {kind:'upload', originalName:'x.jpg'})
 * @param {string} [args.now]      - override timestamp for tests; default Date.now()
 * @returns {Promise<{
 *   id: string,
 *   path: string,
 *   ext: string,
 *   bytes: number,
 *   deduplicated: boolean,
 *   sidecar: Object
 * }>}
 */
export async function ingestStream({ stream, siteRoot, source, now }) {
  const tmpDir = path.join(siteRoot, 'originals', '.tmp');
  await fs.promises.mkdir(tmpDir, { recursive: true });

  const tmpPath = path.join(tmpDir, `ingest-${crypto.randomBytes(8).toString('hex')}.bin`);
  const hasher = crypto.createHash('sha256');
  let bytes = 0;

  const tap = new Transform({
    transform(chunk, _enc, cb) {
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

  let meta;
  try {
    meta = await sharp(tmpPath).metadata();
  } catch (err) {
    await safeUnlink(tmpPath);
    throw new Error(`ingestStream: not a recognized image: ${err.message}`);
  }

  const ext = FORMAT_TO_EXT[meta.format];
  if (!ext) {
    await safeUnlink(tmpPath);
    throw new Error(`ingestStream: unsupported image format ${meta.format}`);
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
  let sidecar = await sidecarRead(siteRoot, id);
  if (!sidecar) {
    sidecar = {
      version: 1,
      original: id,
      source: { fetched, ...source },
      metadata: pickMetadata(meta),
      ops: [],
      outputs: DEFAULT_OUTPUTS,
      variants: DEFAULT_VARIANTS
    };
    await sidecarWrite(siteRoot, id, sidecar);
  }

  return { id, path: finalPath, ext, bytes, deduplicated, sidecar };
}

function pickMetadata(meta) {
  const out = {
    width: meta.width,
    height: meta.height,
    format: meta.format
  };
  // Sharp returns exif as a Buffer; defer parsing until needed (Step 3+).
  // Keep the sidecar JSON-safe by omitting raw buffers here.
  return out;
}

async function exists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function safeUnlink(p) {
  try { await fs.promises.unlink(p); } catch { /* already gone */ }
}

export function originalPath(siteRoot, id, ext) {
  return path.join(siteRoot, 'originals', id.slice(0, 2), id.slice(2, 4), `${id}.${ext}`);
}

export { sidecarPath };
