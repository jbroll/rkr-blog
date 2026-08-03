import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Sidecar } from '@rkr/image-edit';
import { SHARP_PIXEL_LIMIT } from '@rkr/image-edit';
import sharp from 'sharp';

import { cacheKey } from './hash.ts';
import { resolveIds } from './id-resolve.ts';
import type { ImageMap, ImageSource } from './image-map.ts';
import { bakePath, imageInfo } from './originals.ts';
import { resamplePerspective } from './perspective-resample.ts';
import { listSidecarIds } from './posts.ts';
import { applyOp, type Op } from './render.ts';
import { read as sidecarRead } from './sidecar.ts';

const ID_TOKEN = /\b[0-9a-fA-F]{6,64}\b/g;

/** Every image the post body could reference, resolved and measured
 * before rendering starts. Reads run concurrently; the renderer then
 * does no I/O at all. */
export async function buildImageMap(siteRoot: string, body: string): Promise<ImageMap> {
  const raws = [...new Set((body.match(ID_TOKEN) ?? []).map((s) => s.toLowerCase()))];
  if (raws.length === 0) return new Map();
  const known = listSidecarIds(siteRoot);
  const resolved = resolveIds(raws, known);

  const entries = await Promise.all(
    raws.map(async (raw, i): Promise<[string, ImageSource] | null> => {
      const id = resolved[i];
      if (!id) return null;
      const sidecar = await sidecarRead(siteRoot, id);
      if (!sidecar) return null;
      const { width, height } = await imageDimensions(siteRoot, id, sidecar);
      return [raw, makeSource(id, sidecar, width, height)];
    })
  );

  return new Map(entries.filter((e): e is [string, ImageSource] => e !== null));
}

function makeSource(id: string, sidecar: Sidecar, width: number, height: number): ImageSource {
  const ops = sidecar.ops as Parameters<typeof cacheKey>[0]['ops'];
  return {
    sidecar,
    width,
    height,
    urlFor: (w, format, quality) => {
      const oph = cacheKey({
        originalId: id,
        ops,
        variant: { w },
        output: { format: format as Parameters<typeof cacheKey>[0]['output']['format'], quality }
      });
      return `/img/${id}.${oph}.${format}`;
    }
  };
}

/** Read the actual on-disk dimensions of the image the renderer will
 * serve: the bake when ops are applied and the bake exists; the
 * original otherwise. The file IS the source of truth — recording dims
 * elsewhere is a synchronization problem we don't need. The brief
 * in-flight window (ops just changed, bake not yet uploaded) falls
 * back to sidecar.metadata; layout will be very slightly off until
 * the bake lands. */
export async function imageDimensions(
  siteRoot: string,
  id: string,
  sidecar: Sidecar
): Promise<{ width: number; height: number }> {
  const ops = sidecar.ops ?? [];
  if (ops.length === 0) {
    const info = await imageInfo(siteRoot, id);
    return { width: info?.width ?? 1, height: info?.height ?? 1 };
  }
  // Ops present: the post-ops bake on disk IS the source of truth
  // for dims (file == truth). If missing, recreate it server-side
  // from the original + ops via sharp. ensureBake throws for the
  // perspective branch sharp can't handle, surfaced upstream so the
  // operator notices instead of getting silent wrong dims.
  return ensureBake(siteRoot, id, sidecar);
}

/** Return the bake's on-disk dimensions, recreating the file from
 * the original + ops when missing. All op kinds — including
 * perspective — are recreatable: sharp handles crop/rotate/flip/
 * resample directly; perspective uses a pure-JS resampler (see
 * src/lib/perspective-resample.ts) that mirrors the editor's WebGL
 * pipeline pixel-for-pixel.
 *
 * Net effect: any sidecar with ops + no bake self-heals on first
 * request, and the served pixels match what the editor would have
 * baked. File-as-truth holds. */
async function ensureBake(
  siteRoot: string,
  id: string,
  sidecar: Sidecar
): Promise<{ width: number; height: number }> {
  const bp = bakePath(siteRoot, id);
  try {
    const meta = await sharp(bp).metadata();
    if (meta.width && meta.height) return { width: meta.width, height: meta.height };
  } catch {
    /* missing or unreadable; recreate below */
  }
  const ops = (sidecar.ops ?? []) as Op[];
  const info = await imageInfo(siteRoot, id);
  if (!info) {
    throw new Error(`widget-helpers: original missing for ${id.slice(0, 8)}…`);
  }
  const pipeline = await applyOpsWithPerspective(info.path, ops);
  await fs.promises.mkdir(path.dirname(bp), { recursive: true });
  const tmp = `${bp}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await pipeline.webp({ quality: 90 }).toFile(tmp);
    await fs.promises.rename(tmp, bp);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
  // biome-ignore lint/suspicious/noConsole: surface to fly logs when self-healing pre-migration sidecars
  console.warn(`widget-helpers: recreated missing bake for ${id.slice(0, 8)}…`);
  const meta = await sharp(bp).metadata();
  return { width: meta.width ?? 1, height: meta.height ?? 1 };
}

/** Chain ops through sharp, handling perspective with a pure-JS
 * detour. Non-perspective ops compose via the standard sharp chain
 * (applyOp); a perspective op materializes the current pipeline to
 * raw RGBA, runs the JS resampler, then restarts the chain from the
 * resampled buffer. Multiple perspective ops in a row work fine,
 * just with one materialization per op. */
async function applyOpsWithPerspective(srcPath: string, ops: readonly Op[]): Promise<sharp.Sharp> {
  let pipeline: sharp.Sharp = sharp(srcPath, {
    failOn: 'error',
    limitInputPixels: SHARP_PIXEL_LIMIT
  });
  for (const op of ops) {
    if (op.type === 'perspective') {
      const { data, info } = await pipeline
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const result = resamplePerspective(data, info.width, info.height, op);
      if (!result) {
        throw new Error(`widget-helpers: malformed perspective op (corners or homography)`);
      }
      pipeline = sharp(result.buffer, {
        raw: { width: result.width, height: result.height, channels: 4 },
        limitInputPixels: SHARP_PIXEL_LIMIT
      });
    } else {
      pipeline = applyOp(pipeline, op);
    }
  }
  return pipeline;
}
