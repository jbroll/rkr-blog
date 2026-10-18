// Shared request shapes for the gdrive + onedrive integration routes.
// Both providers expose the same Picker-style import flow:
//   - POST /admin/import/<provider>  body = { fileId, name, mimeType }
//   - POST /admin/import/<provider>/video  → ingestVideoStream + derivative
//   - GET  /admin/integrations/<provider>/callback?code=...&state=...
// Extracting these keeps the two route modules from declaring the same
// shapes; per-provider extras (e.g. OneDrive's error_description) are
// added by extending the base types.

import { type Readable, Transform } from 'node:stream';
import type { FastifyReply } from 'fastify';

import { resolveVideoCaps } from '../lib/config.ts';
import { ingestVideoStream, VideoCapError, VideoProbeError } from '../lib/video.ts';
import { renderVideoDerivative, videoCachePaths } from '../lib/video-render.ts';

/** Per-request byte cap shared by every remote-import path (gdrive, onedrive,
 * import-from-url): bounds a single streamed file so a multi-GB source can't be
 * buffered before sharp's pixel guard would fire. */
export const REMOTE_IMPORT_MAX_BYTES = 50 * 1024 * 1024;

/** Stream a fetched remote image body straight to the client with a hard byte
 * cap, image content-type, and no-store. Shared by the gdrive/onedrive
 * `/fetch` endpoints, which hand the standalone editor raw bytes (a Blob to
 * edit locally) rather than ingesting a stored original. */
export function streamImageWithCap(
  reply: FastifyReply,
  body: Readable,
  contentType: string,
  maxBytes: number
): FastifyReply {
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      /* c8 ignore next 3 -- testing the cap requires impractical stream size */
      if (bytes > maxBytes) {
        cb(new Error('streamed bytes exceeded limit'));
        return;
      }
      cb(null, chunk);
    }
  });
  reply.header('content-type', contentType);
  reply.header('cache-control', 'no-store');
  reply.send(body.pipe(limiter));
  return reply;
}

/** POST body for /admin/import/<provider>. The user-facing handler
 * validates fields itself, so unknowns stay loose. */
export interface ProviderImportBody {
  fileId?: unknown;
  name?: unknown;
  mimeType?: unknown;
}

/** Query string for the OAuth callback. `error` is set by the provider
 * when the user denies consent or the request is malformed. */
export interface ProviderCallbackQuery {
  code?: string;
  state?: string;
  error?: string;
}

// ---- cloud video import -------------------------------------------------

/** Response body for POST /admin/import/<provider>/video. Carries the image
 * import fields plus the never-varying cache URLs for the freshly rendered
 * derivative (ops are empty and the poster comes from the sidecar, so both
 * hashes are already known here — no client-side render step). */
export interface VideoImportResponse {
  id: string;
  bytes: number;
  ext: string;
  deduplicated: boolean;
  videoUrl: string;
  posterUrl: string;
}

/** A Transform that aborts the stream once more than maxBytes have passed
 * through it. Used as the pre-cap in front of ingestVideoStream, whose own
 * copy-loop cap only fires after the whole body has been buffered to a tmp
 * file — this one stops an oversized source while it is still streaming. */
function byteCapTransform(maxBytes: number): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        cb(new Error('streamed bytes exceeded limit'));
        return;
      }
      cb(null, chunk);
    }
  });
}

/**
 * Ingest a streamed cloud video (Drive/OneDrive) and render its derivative,
 * returning the admin response shape. Caps come from resolveVideoCaps(siteRoot)
 * — persisted overrides with a DEFAULT_VIDEO_CAPS fallback — and the stream is
 * pre-capped at the same maxBytes so an oversized source aborts mid-flight.
 * Throws VideoCapError / VideoProbeError for the caller to map.
 */
export async function ingestRemoteVideo(args: {
  body: Readable;
  siteRoot: string;
  kind: 'gdrive' | 'onedrive';
  originalName: string;
}): Promise<VideoImportResponse> {
  const { body, siteRoot, kind, originalName } = args;
  const caps = resolveVideoCaps(siteRoot);
  const limiter = byteCapTransform(caps.maxBytes);
  // pipe() only guards the destination while it is flowing; ingestVideoStream
  // awaits an mkdir before its pipeline attaches, and a cap trip inside that
  // gap would otherwise surface as an unhandled 'error' event (crashing the
  // server). The no-op listener covers that window — the error itself still
  // reaches the route through the pipeline's rejection.
  limiter.on('error', () => {});
  const result = await ingestVideoStream({
    stream: body.pipe(limiter),
    siteRoot,
    source: { kind, originalName },
    caps
  });

  const posterTimeMs = result.sidecar.poster.timeMs;
  await renderVideoDerivative({ originalId: result.id, ops: [], posterTimeMs, siteRoot });
  const p = videoCachePaths(siteRoot, result.id, [], posterTimeMs);
  return {
    id: result.id,
    bytes: result.bytes,
    ext: result.ext,
    deduplicated: result.deduplicated,
    videoUrl: `/video/${result.id}.${p.videoOphash}.mp4`,
    posterUrl: `/video/poster/${result.id}.${p.posterOphash}.jpg`
  };
}

/** Map a cloud video-import failure to its HTTP status + message: cap
 * violations are 413, probe failures 422, the streaming pre-cap trip 413,
 * anything else an unexpected 500. Mirrors the admin upload route's mapping. */
export function videoImportError(err: Error): { status: number; message: string } {
  if (err instanceof VideoCapError || err instanceof VideoProbeError) {
    return { status: err.statusCode, message: err.message };
  }
  return { status: /exceeded limit/.test(err.message) ? 413 : 500, message: err.message };
}
