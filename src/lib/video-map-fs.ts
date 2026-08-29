// VideoMap: the facts a ::video widget needs about every video in the
// site, gathered from sidecars/videos/*.json before rendering starts.
// Mirrors image-map-fs.ts — the widget renderer does pure string work off
// this map. Dimensions/duration come from the sidecar's ingest-time probe,
// not a re-probe of the original.

import fs from 'node:fs';
import path from 'node:path';

import { cacheKey } from './hash.ts';
import { POSTER_MAX_WIDTH, VIDEO_MAX_WIDTH } from './video-render.ts';
import { readVideoSidecar, type VideoOp, type VideoSidecar } from './video-sidecar.ts';

export interface VideoSource {
  sidecar: VideoSidecar;
  /** Source pixel dimensions from the ingest-time probe; the widget
   * reserves aspect ratio from these. */
  width: number;
  height: number;
  durationMs: number;
  /**
   * Public URLs for the current ops. The poster FRAME time is accepted for
   * interface symmetry but is not part of the ophash — the hashes match
   * the cache filenames renderVideoDerivative writes.
   */
  urlFor(ops: VideoOp[], posterTimeMs: number): { videoUrl: string; posterUrl: string };
}

/** Keyed by the full 64-hex id (the ::video widget rejects prefixes). */
export type VideoMap = Map<string, VideoSource>;

/** Build the site's video map by scanning sidecars/videos/*.json. */
export async function buildVideoMap(siteRoot: string): Promise<VideoMap> {
  const dir = path.join(siteRoot, 'sidecars', 'videos');
  let files: string[];
  try {
    files = await fs.promises.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw err;
  }

  const ids = files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  const entries = await Promise.all(
    ids.map(async (id): Promise<[string, VideoSource] | null> => {
      const sidecar = await readVideoSidecar(siteRoot, id);
      if (!sidecar) return null;
      return [id, makeVideoSource(id, sidecar)];
    })
  );
  return new Map(entries.filter((e): e is [string, VideoSource] => e !== null));
}

function makeVideoSource(id: string, sidecar: VideoSidecar): VideoSource {
  const { width, height } = videoDimensions(sidecar);
  return {
    sidecar,
    width,
    height,
    durationMs: sidecar.source.durationMs,
    urlFor: (ops, posterTimeMs) => {
      const videoOphash = cacheKey({
        originalId: id,
        ops: ops as never,
        variant: { w: VIDEO_MAX_WIDTH },
        output: { format: 'mp4' }
      });
      const posterOphash = cacheKey({
        originalId: id,
        ops: ops as never,
        variant: { w: POSTER_MAX_WIDTH },
        output: { format: 'jpg' }
      });
      return {
        videoUrl: `/video/${id}.${videoOphash}.mp4`,
        posterUrl: `/video/poster/${id}.${posterOphash}.jpg`
      };
    }
  };
}

/** Source pixel dimensions, straight from the ingest-time probe. */
export function videoDimensions(sidecar: VideoSidecar): { width: number; height: number } {
  return { width: sidecar.source.uploadWidth, height: sidecar.source.uploadHeight };
}
