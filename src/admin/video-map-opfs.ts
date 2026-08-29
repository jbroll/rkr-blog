// Client half of the video map (video spec Task 8): the same facts the
// server's buildVideoMap gathers from sidecars/videos/*.json, sourced
// from OPFS. The admin preview renders the ::video widget off this map.
// There are no local video bytes to make object URLs from (unlike the
// image map) — the preview <video> points at the server's /video/...
// URLs, so urlFor recomputes the exact cache ophashes the server
// derives (canonicalJson + sha256, same input as lib/hash.ts:cacheKey).

import { canonicalJson } from '@rkr/image-edit';

import { listDir, readJson } from './opfs.ts';

/** Derivative long-edge caps for the cache filenames — must match
 * video-render.ts VIDEO_MAX_WIDTH / POSTER_MAX_WIDTH so the browser's
 * URLs land on the same cache entries the server renders. */
const VIDEO_MAX_WIDTH = 1920;
const POSTER_MAX_WIDTH = 640;

/** Structural subset of lib/video-sidecar.ts VideoSidecar, defined
 * locally so this browser-compiled module stays free of node imports. */
interface VideoSidecarView {
  original: string;
  source: {
    uploadWidth: number;
    uploadHeight: number;
    durationMs: number;
  };
  poster: { timeMs: number };
}

interface TrimOp {
  kind: 'trim';
  startMs: number;
  endMs: number;
}

/** Assignable to WidgetCtx's VideoMapView (src/lib/widgets.ts). */
export interface VideoSourceView {
  sidecar: VideoSidecarView;
  width: number;
  height: number;
  durationMs: number;
  urlFor(
    ops: readonly TrimOp[],
    posterTimeMs: number
  ): Promise<{ videoUrl: string; posterUrl: string }>;
}

/**
 * Build the site's video map from the OPFS mirror of sidecars/videos.
 * opfsRoot/fetchFn are interface-parity params (mirroring the plan's
 * signature): the OPFS reads go through the shared opfs.ts helpers
 * against the browser's navigator.storage root, and there is no remote
 * fetch step today.
 */
export async function buildVideoMapFromOpfs(
  _opfsRoot?: unknown,
  _fetchFn?: typeof fetch
): Promise<Map<string, VideoSourceView>> {
  const files = await listDir('sidecars/videos');
  const ids = files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((id) => /^[0-9a-f]{64}$/.test(id));

  const entries = await Promise.all(
    ids.map(async (id): Promise<[string, VideoSourceView] | null> => {
      const sidecar = await readJson<VideoSidecarView>(`sidecars/videos/${id}.json`);
      if (!sidecar) return null;
      return [id, makeVideoSource(id, sidecar)];
    })
  );
  return new Map(entries.filter((e): e is [string, VideoSourceView] => e !== null));
}

function makeVideoSource(id: string, sidecar: VideoSidecarView): VideoSourceView {
  return {
    sidecar,
    width: sidecar.source.uploadWidth,
    height: sidecar.source.uploadHeight,
    durationMs: sidecar.source.durationMs,
    urlFor: async (ops, posterTimeMs) => {
      const videoOphash = await cacheKeyForVideo({
        originalId: id,
        ops,
        variant: { w: VIDEO_MAX_WIDTH },
        output: { format: 'mp4' }
      });
      const posterOphash = await cacheKeyForVideo({
        originalId: id,
        ops,
        variant: { w: POSTER_MAX_WIDTH },
        output: { format: 'jpg', posterTimeMs: posterHashTime(ops, posterTimeMs) }
      });
      return {
        videoUrl: `/video/${id}.${videoOphash}.mp4`,
        posterUrl: `/video/poster/${id}.${posterOphash}.jpg`
      };
    }
  };
}

/** Browser-side cacheKey: sha256(canonicalJson(...)) hex, first 12 chars
 * — identical to lib/hash.ts:cacheKey so server and client agree. */
async function cacheKeyForVideo(input: {
  originalId: string;
  ops: unknown;
  variant: Record<string, unknown>;
  output: Record<string, unknown>;
}): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(input));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}

/** Poster hash input clamps the time into the trim window, mirroring
 * video-map-fs.ts's clampPosterForHash so both sides mint the same
 * poster ophash for the same poster time. */
function posterHashTime(ops: readonly TrimOp[], timeMs: number): number {
  const trimOp = ops.find((op) => op.kind === 'trim');
  if (trimOp === undefined) {
    return Number.isFinite(timeMs) ? timeMs : 0;
  }
  const lo = Math.max(0, trimOp.startMs);
  const hi = Math.max(lo, trimOp.endMs - 1);
  if (!Number.isFinite(timeMs)) return lo;
  return Math.min(Math.max(timeMs, lo), hi);
}
