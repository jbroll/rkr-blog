// Admin video routes: multipart ingest + non-destructive trim. Kept out
// of admin.ts (which is at its size cap) in its own register function,
// same pattern as admin-tags.ts / admin-archive.ts.

import fs from 'node:fs';

import type { FastifyInstance } from 'fastify';

import { resolveVideoCaps } from '../lib/config.ts';
import { ingestVideoStream, VideoCapError, VideoProbeError } from '../lib/video.ts';
import { renderVideoDerivative, videoCachePaths } from '../lib/video-render.ts';
import { readVideoSidecar, videoSidecarPath, writeVideoSidecar } from '../lib/video-sidecar.ts';

export interface AdminVideoRoutesOpts {
  siteRoot: string;
  /** Auth preHandler spread, e.g. { preHandler: requireUser }. */
  guard: Record<string, unknown>;
}

export function registerAdminVideoRoutes(
  fastify: FastifyInstance,
  { siteRoot, guard }: AdminVideoRoutesOpts
): void {
  // POST /admin/upload/video — multipart video ingest, same shape as the
  // image upload. ingestVideoStream hashes while streaming, probes with
  // ffprobe, dedups on the byte hash, and writes originals/videos +
  // sidecars/videos; then renderVideoDerivative transcodes the mp4 + jpeg
  // poster so the returned URLs are immediately servable. Error mapping:
  // probe failure → 422 (unrecognized bytes), cap violation → 413.
  fastify.post('/admin/upload/video', { ...guard }, async (request, reply) => {
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: 'no file part' });

    try {
      const result = await ingestVideoStream({
        stream: part.file,
        siteRoot,
        source: { kind: 'upload', originalName: part.filename ?? '' },
        caps: resolveVideoCaps(siteRoot)
      });

      // @fastify/multipart sets file.truncated when the server-level size
      // limit was hit mid-stream. ingestVideoStream already wrote the
      // partial bytes + possibly a sidecar. Only delete files we just
      // created; if the upload deduplicated against an existing id, leave
      // the existing original and sidecar untouched.
      if (part.file.truncated) {
        if (!result.deduplicated) {
          await fs.promises.unlink(result.path).catch(() => {});
          await fs.promises.unlink(videoSidecarPath(siteRoot, result.id)).catch(() => {});
        }
        return reply.code(413).send({ error: 'file too large' });
      }

      const posterTimeMs = result.sidecar.poster.timeMs;
      await renderVideoDerivative({ originalId: result.id, ops: [], posterTimeMs, siteRoot });
      const p = videoCachePaths(siteRoot, result.id, [], posterTimeMs);

      return {
        id: result.id,
        videoUrl: `/video/${result.id}.${p.videoOphash}.mp4`,
        posterUrl: `/video/poster/${result.id}.${p.posterOphash}.jpg`,
        durationMs: result.durationMs,
        width: result.width,
        height: result.height
      };
    } catch (err) {
      if (err instanceof VideoCapError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      if (err instanceof VideoProbeError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      request.log.error({ err }, 'video upload failed');
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // POST /admin/video/:id/trim — non-destructive trim + poster time for an
  // ingested video. Rewrites the sidecar's ops/poster (the original bytes
  // never change); the cache is content-addressed, so old derivative files
  // remain on disk under their immutable ophash URLs and the new URLs get
  // a fresh render on first public request.
  fastify.post<{
    Params: { id: string };
    Body: { startMs?: unknown; endMs?: unknown; posterTimeMs?: unknown };
  }>('/admin/video/:id/trim', { ...guard }, async (request, reply) => {
    const { id } = request.params;
    if (!/^[0-9a-f]{64}$/.test(id)) {
      return reply.code(400).send({ error: 'video id must be a 64-char lowercase sha256 hex id' });
    }
    const sidecar = await readVideoSidecar(siteRoot, id);
    if (!sidecar) return reply.code(404).send({ error: 'unknown video' });

    const durationMs = sidecar.source.durationMs;
    const startMs = Number(request.body?.startMs);
    const endMs = Number(request.body?.endMs);
    const posterTimeMs = Number(request.body?.posterTimeMs);

    const valid = (n: number): boolean => Number.isInteger(n) && n >= 0;
    if (!valid(startMs) || !valid(endMs) || !valid(posterTimeMs)) {
      return reply
        .code(422)
        .send({ error: 'startMs, endMs, posterTimeMs must be non-negative integers' });
    }
    if (startMs >= endMs) {
      return reply.code(422).send({ error: 'startMs must be less than endMs' });
    }
    if (endMs > durationMs) {
      return reply
        .code(422)
        .send({ error: `endMs ${endMs} is beyond the video duration ${durationMs}` });
    }
    if (posterTimeMs > durationMs) {
      return reply
        .code(422)
        .send({ error: `posterTimeMs ${posterTimeMs} is beyond the video duration ${durationMs}` });
    }

    // The full 0..durationMs range is the untrimmed video → no trim op.
    sidecar.ops = startMs === 0 && endMs === durationMs ? [] : [{ kind: 'trim', startMs, endMs }];
    sidecar.poster.timeMs = posterTimeMs;
    delete sidecar.redoStack;
    await writeVideoSidecar(siteRoot, id, sidecar);

    const p = videoCachePaths(siteRoot, id, sidecar.ops, posterTimeMs);
    return {
      videoUrl: `/video/${id}.${p.videoOphash}.mp4`,
      posterUrl: `/video/poster/${id}.${p.posterOphash}.jpg`
    };
  });
}
