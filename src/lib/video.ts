// Streaming ingest of a video into originals/videos/ + sidecars/videos/.
// Hash-while-stream so the upload bytes are read exactly once; ffprobe
// supplies dimensions/duration/format for the sidecar and the caps
// check. The original is never transcoded here — the render step reads
// this file as its only input. On-disk layout mirrors originals/:
//   originals/videos/<id[0:2]>/<id[2:4]>/<id>.<ext>

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { DEFAULT_VIDEO_CAPS, type VideoCaps } from './config.ts';
import { probeVideo, type VideoProbe } from './video-ffmpeg.ts';
import {
  makeDefaultVideoSidecar,
  readVideoSidecar,
  type VideoSidecar,
  writeVideoSidecar
} from './video-sidecar.ts';

export class VideoProbeError extends Error {
  readonly statusCode = 422;
  constructor(message: string) {
    super(message);
    this.name = 'VideoProbeError';
  }
}

export class VideoCapError extends Error {
  readonly statusCode = 413;
  constructor(message: string) {
    super(message);
    this.name = 'VideoCapError';
  }
}

export interface IngestVideoArgs {
  stream: Readable;
  siteRoot: string;
  source: {
    kind: VideoSidecar['source']['kind'];
    originalName: string;
    fetchedAt?: string;
  };
  /** Per-call cap overrides; missing fields fall through to DEFAULT_VIDEO_CAPS. */
  caps?: VideoCaps;
}

export interface IngestVideoResult {
  id: string;
  path: string;
  ext: string;
  bytes: number;
  deduplicated: boolean;
  sidecar: VideoSidecar;
  durationMs: number;
  width: number;
  height: number;
}

/** Map ffprobe container names to a single on-disk ext. */
const FORMAT_TO_EXT: Record<string, string> = {
  mov: 'mp4', // quicktime: same h264/aac tracks, plays as mp4
  m4v: 'mp4',
  '3gp': 'mp4'
};

/** Ext candidates findExistingVideoOriginal probes: every ext ingest
 * writes plus common upload formats, so dedup honors legacy files. */
const VIDEO_EXT_CANDIDATES = [
  'mp4',
  'mov',
  'm4v',
  'webm',
  'matroska',
  'mkv',
  'avi',
  'mpeg',
  'mpg',
  'mts',
  'm2ts',
  'flv',
  'wmv',
  'ogg',
  'ogv'
];

export function videoOriginalPath(siteRoot: string, id: string, ext: string): string {
  return path.join(siteRoot, 'originals', 'videos', id.slice(0, 2), id.slice(2, 4), `${id}.${ext}`);
}

/** On-disk ext for a probe's format_name: first container token,
 * lowercased, with the mp4 family canonicalized to "mp4". */
export function extFromProbeFormat(format: string): string {
  const first = (format.split(',')[0] ?? '').toLowerCase();
  return FORMAT_TO_EXT[first] ?? first;
}

/** Resolve the on-disk original for an id across known video exts.
 * Returns the first hit, or undefined when the id is fresh. */
export async function findExistingVideoOriginal(
  siteRoot: string,
  id: string
): Promise<{ path: string; ext: string } | undefined> {
  const dir = path.join(siteRoot, 'originals', 'videos', id.slice(0, 2), id.slice(2, 4));
  for (const ext of VIDEO_EXT_CANDIDATES) {
    const p = path.join(dir, `${id}.${ext}`);
    if (await exists(p)) return { path: p, ext };
  }
  return undefined;
}

/** Ingest a Readable byte stream into the site's video originals +
 * sidecars trees: hash-while-stream, probe for caps + metadata, dedup
 * on the byte hash. */
export async function ingestVideoStream({
  stream,
  siteRoot,
  source,
  caps
}: IngestVideoArgs): Promise<IngestVideoResult> {
  const limits = { ...DEFAULT_VIDEO_CAPS, ...(caps ?? {}) };
  const tmpDir = path.join(siteRoot, 'originals', 'videos', '.tmp');
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

  let probe: VideoProbe;
  try {
    probe = await probeVideo(tmpPath);
  } catch (err) {
    await safeUnlink(tmpPath);
    throw new VideoProbeError(`video ingest: probe failed: ${(err as Error).message}`);
  }

  if (bytes > limits.maxBytes) {
    await safeUnlink(tmpPath);
    throw new VideoCapError(`video exceeds maxBytes cap: ${bytes} > ${limits.maxBytes}`);
  }
  if (probe.durationMs > limits.maxDurationMs) {
    await safeUnlink(tmpPath);
    throw new VideoCapError(
      `video exceeds maxDurationMs cap: ${probe.durationMs} > ${limits.maxDurationMs}`
    );
  }
  // maxWidth is the long edge (config.ts: "Max accepted source width in
  // px (long edge)"), so portrait uploads are measured on their height.
  const longEdge = Math.max(probe.width, probe.height);
  if (longEdge > limits.maxWidth) {
    await safeUnlink(tmpPath);
    throw new VideoCapError(`video exceeds maxWidth cap: ${longEdge} > ${limits.maxWidth}`);
  }

  const existingOriginal = await findExistingVideoOriginal(siteRoot, id);

  let ext: string;
  let finalPath: string;
  let deduplicated = false;

  if (existingOriginal) {
    deduplicated = true;
    ext = existingOriginal.ext;
    finalPath = existingOriginal.path;
    await safeUnlink(tmpPath);
  } else {
    ext = extFromProbeFormat(probe.format);
    const finalDir = path.join(siteRoot, 'originals', 'videos', id.slice(0, 2), id.slice(2, 4));
    finalPath = path.join(finalDir, `${id}.${ext}`);
    await fs.promises.mkdir(finalDir, { recursive: true });
    await fs.promises.rename(tmpPath, finalPath);
  }

  // Reuse the existing sidecar if present (dedup path) to preserve user
  // edits to ops/poster; only create one when none exists.
  const existing = await readVideoSidecar(siteRoot, id);
  const sidecar =
    existing ??
    (await (async (): Promise<VideoSidecar> => {
      const fresh = makeDefaultVideoSidecar(id, {
        source,
        probe: {
          width: probe.width,
          height: probe.height,
          durationMs: probe.durationMs,
          codecVideo: probe.codecVideo,
          codecAudio: probe.codecAudio,
          format: probe.format
        },
        bytes,
        storedHash: id // upload bytes == on-disk bytes, so storedHash == id
      });
      await writeVideoSidecar(siteRoot, id, fresh);
      return fresh;
    })());

  return {
    id,
    path: finalPath,
    ext,
    bytes,
    deduplicated,
    sidecar,
    durationMs: probe.durationMs,
    width: probe.width,
    height: probe.height
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
