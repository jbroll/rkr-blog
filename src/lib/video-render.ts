// Transcode + poster rendering for the video pipeline. Same shape as
// render.ts: content-addressed cache filenames, atomic tmp+rename writes,
// and a module-level inflight dedup + Semaphore(1) so a burst of requests
// for one derivative shares a single ffmpeg run.
//
// Cache identity: video ophash = cacheKey({originalId, ops,
// variant:{w:1920}, output:{format:"mp4"}}); the poster ophash uses
// variant:{w:640} + jpg. The poster FRAME time is a render parameter
// (clamped into the playable window) but not part of either ophash — the
// serving route recomputes hashes from the sidecar alone.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { cacheKey } from './hash.ts';
import { Semaphore } from './semaphore.ts';
import { findExistingVideoOriginal } from './video.ts';
import { buildFfmpegArgs, buildPosterArgs, runFfmpeg } from './video-ffmpeg.ts';
import { readVideoSidecar, type VideoOp } from './video-sidecar.ts';

/** Long-edge cap for the transcoded mp4 (spec: max 1920w). */
export const VIDEO_MAX_WIDTH = 1920;
/** Long-edge cap for the jpeg poster frame. */
export const POSTER_MAX_WIDTH = 640;
/** Transcode budget: up to 300s of source at preset fast can run ~real-time. */
const TRANSCODE_TIMEOUT_MS = 600_000;
const POSTER_TIMEOUT_MS = 60_000;

export interface VideoDerivativeArgs {
  originalId: string;
  ops: VideoOp[];
  posterTimeMs: number;
  siteRoot: string;
  /** Bypass the cache fast path; the existing files are atomically replaced. */
  force?: boolean;
}

export interface VideoRenderResult {
  videoPath: string;
  posterPath: string;
  bytes: number;
  cached: boolean;
}

export interface VideoCachePaths {
  videoPath: string;
  posterPath: string;
  videoOphash: string;
  posterOphash: string;
}

/** Cache filename for one derivative: <id>.<oph>.<mp4|jpg>. */
export function videoFilename(id: string, ops: VideoOp[], poster: boolean): string {
  const oph = cacheKey({
    originalId: id,
    ops: ops as never,
    variant: { w: poster ? POSTER_MAX_WIDTH : VIDEO_MAX_WIDTH },
    output: { format: poster ? 'jpg' : 'mp4' }
  });
  return `${id}.${oph}.${poster ? 'jpg' : 'mp4'}`;
}

/** On-disk paths and ophashes for a derivative pair under cache/video.
 * `posterTimeMs` is accepted for interface symmetry but is not part of the
 * cache identity (see the file header). */
export function videoCachePaths(
  siteRoot: string,
  id: string,
  ops: VideoOp[],
  posterTimeMs: number
): VideoCachePaths {
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
    videoPath: path.join(siteRoot, 'cache', 'video', `${id}.${videoOphash}.mp4`),
    posterPath: path.join(siteRoot, 'cache', 'video', `${id}.${posterOphash}.jpg`),
    videoOphash,
    posterOphash
  };
}

const inflightRenders = new Map<string, Promise<VideoRenderResult>>();
// One transcode at a time: a single-vCPU box can't profitably run
// parallel ffmpeg encodes, and serializing them keeps the burst of
// requests from piling up memory.
const renderSemaphore = new Semaphore(1);

/**
 * Render the normalized mp4 + jpeg poster for a video derivative. Returns
 * the on-disk paths, the mp4 byte length, and whether both files were
 * already in cache.
 */
export async function renderVideoDerivative(args: VideoDerivativeArgs): Promise<VideoRenderResult> {
  const { originalId, ops, siteRoot, force = false } = args;
  const cachePaths = videoCachePaths(siteRoot, originalId, ops, args.posterTimeMs);

  // Cache hit fast path: both files must exist — a video without its
  // poster is a partial render and is rebuilt.
  if (!force) {
    const [videoOk, posterOk] = await Promise.all([
      exists(cachePaths.videoPath),
      exists(cachePaths.posterPath)
    ]);
    if (videoOk && posterOk) {
      const stat = await fs.promises.stat(cachePaths.videoPath);
      return {
        videoPath: cachePaths.videoPath,
        posterPath: cachePaths.posterPath,
        bytes: stat.size,
        cached: true
      };
    }
  }

  const original = await findExistingVideoOriginal(siteRoot, originalId);
  if (!original) {
    throw new Error(`renderVideoDerivative: no original on disk for ${originalId}`);
  }

  // Clamp the poster frame into the playable window: the trim range when
  // trimmed, [0, durationMs) otherwise. A missing sidecar means the
  // duration is unknown, so the poster lands at the window start.
  const sidecar = await readVideoSidecar(siteRoot, originalId);
  const durationMs = sidecar?.source.durationMs ?? 0;
  const trimOp = ops.find((op) => op.kind === 'trim');
  const startMs = trimOp?.startMs ?? 0;
  const endMs = trimOp?.endMs ?? durationMs;
  const posterTimeMs = clampPosterTime(args.posterTimeMs, startMs, endMs);

  // Dedup: concurrent renders of the same derivative share one promise.
  // The map entry is cleared on settle so the next cache-miss request
  // re-enters the cache fast path.
  const key = path.basename(cachePaths.videoPath);
  let render = inflightRenders.get(key);
  if (!render) {
    render = (async () => {
      await renderSemaphore.acquire();
      try {
        return await doRender(cachePaths, original.path, ops, posterTimeMs);
      } finally {
        renderSemaphore.release();
      }
    })().finally(() => {
      inflightRenders.delete(key);
    });
    inflightRenders.set(key, render);
    // A caller that abandoned the promise (route answered 202 on budget
    // timeout) must not trip an unhandled-rejection handler.
    render.catch((_err: unknown) => {});
  }
  return render;
}

async function doRender(
  cachePaths: VideoCachePaths,
  originalPath: string,
  ops: VideoOp[],
  posterTimeMs: number
): Promise<VideoRenderResult> {
  await fs.promises.mkdir(path.dirname(cachePaths.videoPath), { recursive: true });
  const videoTmp = `${cachePaths.videoPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const posterTmp = `${cachePaths.posterPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;

  const trimOp = ops.find((op) => op.kind === 'trim');
  try {
    await runFfmpeg(
      buildFfmpegArgs({
        input: originalPath,
        output: videoTmp,
        startMs: trimOp?.startMs,
        endMs: trimOp?.endMs,
        maxWidth: VIDEO_MAX_WIDTH
      }),
      { timeoutMs: TRANSCODE_TIMEOUT_MS }
    );
    // Poster comes from the transcoded mp4 so the frame matches the
    // trimmed/clamped timeline exactly.
    await runFfmpeg(buildPosterArgs({ input: videoTmp, timeMs: posterTimeMs, output: posterTmp }), {
      timeoutMs: POSTER_TIMEOUT_MS
    });
    await fs.promises.rename(videoTmp, cachePaths.videoPath);
    await fs.promises.rename(posterTmp, cachePaths.posterPath);
  } catch (err) {
    await safeUnlink(videoTmp);
    await safeUnlink(posterTmp);
    throw err;
  }

  const stat = await fs.promises.stat(cachePaths.videoPath);
  return {
    videoPath: cachePaths.videoPath,
    posterPath: cachePaths.posterPath,
    bytes: stat.size,
    cached: false
  };
}

/** Clamp into [startMs, endMs): the upper bound is exclusive, so the last
 * usable millisecond is endMs - 1. Degenerate windows collapse to their
 * start. */
function clampPosterTime(timeMs: number, startMs: number, endMs: number): number {
  const lo = Math.max(0, startMs);
  const hi = Math.max(lo, endMs - 1);
  if (!Number.isFinite(timeMs)) return lo;
  return Math.min(Math.max(timeMs, lo), hi);
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
