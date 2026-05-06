// Image derivative renderer. Pure modulo filesystem writes:
// same args → same on-disk path → same bytes (assuming a stable libvips).
// See spec §11.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

import { cacheKey } from './hash.js';
import { originalPath } from './originals.js';
import { read as sidecarRead } from './sidecar.js';

const FORMAT_TO_EXT = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  gif: 'gif',
  tiff: 'tiff',
  heif: 'heif'
};

/**
 * Compute the cache filename for a derivative.
 * Format: <originalId>.<ophash>.<format>
 */
export function derivativeFilename({ originalId, ops, variant, output }) {
  const oph = cacheKey({ originalId, ops, variant, output });
  return `${originalId}.${oph}.${output.format}`;
}

export function derivativePath(siteRoot, args) {
  return path.join(siteRoot, 'cache', 'img', derivativeFilename(args));
}

/**
 * Render one derivative. Returns the on-disk path, byte length, and whether
 * the result was already in cache.
 *
 * @param {Object} args
 * @param {string} args.originalId
 * @param {Array}  args.ops
 * @param {Object} args.variant
 * @param {Object} args.output
 * @param {string} args.siteRoot
 * @returns {Promise<{ path: string, bytes: number, cached: boolean }>}
 */
export async function renderDerivative({ originalId, ops, variant, output, siteRoot }) {
  const finalPath = derivativePath(siteRoot, { originalId, ops, variant, output });

  // Cache hit fast path: stat the file. Don't even import the original.
  try {
    const stat = await fs.promises.stat(finalPath);
    return { path: finalPath, bytes: stat.size, cached: true };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // Cache miss: locate the original via the sidecar and run the pipeline.
  const sidecar = await sidecarRead(siteRoot, originalId);
  if (!sidecar) {
    throw new Error(`renderDerivative: no sidecar for ${originalId}`);
  }
  const ext = FORMAT_TO_EXT[sidecar.metadata.format];
  if (!ext) {
    throw new Error(`renderDerivative: unsupported original format ${sidecar.metadata.format}`);
  }
  const origPath = originalPath(siteRoot, originalId, ext);

  // Per spec §11: keep libvips threads from multiplying with job concurrency.
  sharp.concurrency(1);

  let pipeline = sharp(origPath, { failOn: 'error' });
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

function applyOp(p, op) {
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
    default:
      throw new Error(`renderDerivative: unknown op type ${op.type}`);
  }
}

function applyVariant(p, variant) {
  if (!variant) return p;
  if (variant.w == null && variant.h == null) return p;
  return p.resize({
    width: variant.w,
    height: variant.h,
    fit: variant.fit ?? 'inside',
    withoutEnlargement: true
  });
}

function applyOutput(p, output) {
  switch (output.format) {
    case 'webp':
      return p.webp({ quality: output.quality ?? 85, effort: output.effort ?? 4 });
    case 'avif':
      return p.avif({ quality: output.quality ?? 70, effort: output.effort ?? 4 });
    case 'jpeg':
      return p.jpeg({ quality: output.quality ?? 85, mozjpeg: false });
    case 'png':
      return p.png({ compressionLevel: 6 });
    default:
      throw new Error(`renderDerivative: unknown output format ${output.format}`);
  }
}
