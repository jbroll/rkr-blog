// Video sidecar JSON read/write/validate. One file per logical video at
// $SITE_ROOT/sidecars/videos/<id>.json (see spec.md §1.2). Types live here
// (not in the image-edit package) so the video pipeline stays isolated from
// the image sidecar schema.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CURRENT_VIDEO_SIDE_VERSION = 1;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type VideoValidateResult = { ok: true } | { ok: false; error: string };

export interface VideoOp {
  kind: 'trim';
  startMs: number;
  endMs: number;
}

export interface VideoSidecar {
  version: 1;
  /** sha256 hex id of the original bytes; matches the sidecar filename. */
  original: string;
  source: {
    kind: 'upload' | 'url' | 'gdrive' | 'onedrive';
    fetchedAt: string; // ISO
    originalName: string;
    storedHash: string; // sha256 hex of the bytes on disk
    uploadFormat: string; // e.g. "mp4" | "mov" | "webm"
    uploadBytes: number;
    uploadWidth: number;
    uploadHeight: number;
    durationMs: number;
    probe: { codecVideo: string; codecAudio: string | null };
  };
  ops: VideoOp[];
  redoStack?: VideoOp[];
  outputs: [{ format: 'mp4'; codec: 'h264/aac'; quality?: number }];
  poster: { timeMs: number };
}

/** Ingest-time metadata for makeDefaultVideoSidecar. */
export interface VideoSidecarMeta {
  source: {
    kind: VideoSidecar['source']['kind'];
    originalName: string;
    fetchedAt?: string;
  };
  probe: {
    width: number;
    height: number;
    durationMs: number;
    codecVideo: string;
    codecAudio: string | null;
    format: string;
  };
  bytes: number;
  storedHash: string;
  posterTimeMs?: number;
}

/** Read a video sidecar by original id. Returns null if it doesn't exist. */
export async function readVideoSidecar(siteRoot: string, id: string): Promise<VideoSidecar | null> {
  const p = videoSidecarPath(siteRoot, id);
  try {
    const raw = await fs.promises.readFile(p, 'utf8');
    return JSON.parse(raw) as VideoSidecar;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Atomically write a video sidecar. Validates first. */
export async function writeVideoSidecar(
  siteRoot: string,
  id: string,
  data: VideoSidecar
): Promise<void> {
  const v = validateVideoSidecar(data);
  if (!v.ok) throw new Error(`videoSidecar.write: invalid data: ${v.error}`);
  if (data.original !== id) {
    throw new Error(`videoSidecar.write: id mismatch (path=${id}, data.original=${data.original})`);
  }

  const dir = path.join(siteRoot, 'sidecars', 'videos');
  await fs.promises.mkdir(dir, { recursive: true });

  const final = videoSidecarPath(siteRoot, id);
  const tmp = `${final}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tmp, final);
}

/**
 * Validate video sidecar shape. Conservative — checks required keys and types,
 * without enforcing every constraint of the schema. Unknown keys are allowed
 * so callers can add fields without invalidating existing data.
 */
export function validateVideoSidecar(data: unknown): VideoValidateResult {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'video sidecar must be an object' };
  }
  const d = data as Record<string, unknown>;

  if (d.version !== CURRENT_VIDEO_SIDE_VERSION) {
    return { ok: false, error: `unsupported version ${String(d.version)}` };
  }

  if (typeof d.original !== 'string' || !SHA256_HEX.test(d.original)) {
    return { ok: false, error: 'original must be a 64-char lowercase sha256 hex string' };
  }

  if (d.source === null || typeof d.source !== 'object' || Array.isArray(d.source)) {
    return { ok: false, error: 'source must be an object' };
  }
  const source = d.source as Record<string, unknown>;
  if (typeof source.kind !== 'string') {
    return { ok: false, error: 'source.kind must be a string' };
  }
  if (typeof source.fetchedAt !== 'string') {
    return { ok: false, error: 'source.fetchedAt must be an ISO string' };
  }
  if (typeof source.originalName !== 'string') {
    return { ok: false, error: 'source.originalName must be a string' };
  }
  if (typeof source.storedHash !== 'string' || !SHA256_HEX.test(source.storedHash)) {
    return { ok: false, error: 'source.storedHash must be a 64-char lowercase sha256 hex string' };
  }
  if (typeof source.uploadFormat !== 'string') {
    return { ok: false, error: 'source.uploadFormat must be a string' };
  }
  for (const k of ['uploadBytes', 'uploadWidth', 'uploadHeight', 'durationMs'] as const) {
    if (typeof source[k] !== 'number') {
      return { ok: false, error: `source.${k} must be a number` };
    }
  }
  if (source.probe === null || typeof source.probe !== 'object' || Array.isArray(source.probe)) {
    return { ok: false, error: 'source.probe must be an object' };
  }
  const probe = source.probe as Record<string, unknown>;
  if (typeof probe.codecVideo !== 'string') {
    return { ok: false, error: 'source.probe.codecVideo must be a string' };
  }
  if (probe.codecAudio !== null && typeof probe.codecAudio !== 'string') {
    return { ok: false, error: 'source.probe.codecAudio must be a string or null' };
  }

  if (!Array.isArray(d.ops)) {
    return { ok: false, error: 'ops must be an array' };
  }
  // redoStack is optional; if present, must be an array.
  if (d.redoStack !== undefined && !Array.isArray(d.redoStack)) {
    return { ok: false, error: 'redoStack must be an array' };
  }

  if (!Array.isArray(d.outputs) || d.outputs.length !== 1) {
    return { ok: false, error: 'outputs must be an array of length 1' };
  }
  const output = d.outputs[0];
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return { ok: false, error: 'outputs[0] must be an object' };
  }
  if ((output as Record<string, unknown>).format !== 'mp4') {
    return { ok: false, error: 'outputs[0].format must be "mp4"' };
  }

  if (d.poster === null || typeof d.poster !== 'object' || Array.isArray(d.poster)) {
    return { ok: false, error: 'poster must be an object' };
  }
  if (typeof (d.poster as Record<string, unknown>).timeMs !== 'number') {
    return { ok: false, error: 'poster.timeMs must be a number' };
  }

  return { ok: true };
}

/** Build the default sidecar for a freshly ingested video (spec §1.2). */
export function makeDefaultVideoSidecar(id: string, meta: VideoSidecarMeta): VideoSidecar {
  const posterTimeMs = meta.posterTimeMs ?? Math.min(1000, Math.floor(meta.probe.durationMs / 2));
  return {
    version: CURRENT_VIDEO_SIDE_VERSION,
    original: id,
    source: {
      kind: meta.source.kind,
      fetchedAt: meta.source.fetchedAt ?? new Date().toISOString(),
      originalName: meta.source.originalName,
      storedHash: meta.storedHash,
      uploadFormat: meta.probe.format.toLowerCase(),
      uploadBytes: meta.bytes,
      uploadWidth: meta.probe.width,
      uploadHeight: meta.probe.height,
      durationMs: meta.probe.durationMs,
      probe: { codecVideo: meta.probe.codecVideo, codecAudio: meta.probe.codecAudio }
    },
    ops: [],
    outputs: [{ format: 'mp4', codec: 'h264/aac' }],
    poster: { timeMs: posterTimeMs }
  };
}

export function videoSidecarPath(siteRoot: string, id: string): string {
  return path.join(siteRoot, 'sidecars', 'videos', `${id}.json`);
}
