// Client half of the image prepass (docs/spec-offline.md §6): the same
// prepass the server runs, sourced from OPFS. sharp isn't available here,
// so a missing bake falls back to the sidecar's recorded dimensions —
// layout is slightly off until the bake syncs.

import type { Sidecar } from '@rkr/image-edit';

import { collectFigureIds, type FigureIdSource } from '../lib/figure-ids.ts';
import { resolveIds } from '../lib/id-resolve.ts';
import type { ImageMap, ImageSource } from '../lib/image-map.ts';
import { listDir, readBlob, readJson } from './opfs.ts';
import { OPFS_DIRS } from './opfs-schema.ts';

/** 1×1 transparent GIF. Stands in for an image whose bytes were never
 * pulled to this device, so the layout still reserves its box. */
export const MISSING_IMAGE_URL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const ORIGINAL_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic'];

export interface OpfsMapOpts {
  decode?: (blob: Blob) => Promise<{ width: number; height: number }>;
  toUrl?: (blob: Blob) => string;
}

async function decodeSize(blob: Blob): Promise<{ width: number; height: number }> {
  const bmp = await createImageBitmap(blob);
  const size = { width: bmp.width, height: bmp.height };
  bmp.close();
  return size;
}

export async function buildImageMapFromOpfs(
  source: FigureIdSource,
  opts: OpfsMapOpts = {}
): Promise<ImageMap> {
  const decode = opts.decode ?? decodeSize;
  const toUrl = opts.toUrl ?? ((b: Blob) => URL.createObjectURL(b));

  const raws = collectFigureIds(source);
  if (raws.length === 0) return new Map();

  const known = (await listDir(OPFS_DIRS.SIDECARS))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter((id) => /^[0-9a-f]{64}$/.test(id));
  const resolved = resolveIds(raws, known);

  const entries = await Promise.all(
    raws.map(async (raw, i): Promise<[string, ImageSource] | null> => {
      const id = resolved[i];
      if (!id) return null;
      const sidecar = await readJson<Sidecar>(`${OPFS_DIRS.SIDECARS}/${id}.json`);
      if (!sidecar) return null;
      const blob = await loadBytes(id, sidecar);
      const url = blob ? toUrl(blob) : MISSING_IMAGE_URL;
      const { width, height } = await sizeOf(blob, sidecar, decode);
      return [raw, { sidecar, width, height, urlFor: () => url }];
    })
  );

  return new Map(entries.filter((e): e is [string, ImageSource] => e !== null));
}

/** The bake when ops are applied, the original otherwise — mirroring
 * the server's file-as-truth rule. */
async function loadBytes(id: string, sidecar: Sidecar): Promise<Blob | null> {
  if ((sidecar.ops ?? []).length > 0) {
    const bake = await readBlob(`${OPFS_DIRS.BAKES}/${id}.webp`);
    if (bake) return bake;
    return null;
  }
  for (const ext of ORIGINAL_EXTS) {
    const b = await readBlob(`${OPFS_DIRS.ORIGINALS}/${id}.${ext}`);
    if (b) return b;
  }
  return null;
}

async function sizeOf(
  blob: Blob | null,
  sidecar: Sidecar,
  decode: (b: Blob) => Promise<{ width: number; height: number }>
): Promise<{ width: number; height: number }> {
  if (blob) {
    try {
      return await decode(blob);
    } catch {
      /* undecodable; fall through to the recorded dimensions */
    }
  }
  const legacy = (sidecar as { metadata?: { width?: number; height?: number } }).metadata;
  if (legacy?.width && legacy.height) return { width: legacy.width, height: legacy.height };
  const src = sidecar.source;
  if (src.uploadWidth && src.uploadHeight) {
    return { width: src.uploadWidth, height: src.uploadHeight };
  }
  return { width: 1, height: 1 };
}
