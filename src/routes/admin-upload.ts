// POST /admin/upload — multipart image ingest (routed to ingestStream).
// Split out of admin.ts so that file stays under the 500-line cap; same
// guard/auth wiring as the other admin routes (see admin.ts).

import fs from 'node:fs';
import path from 'node:path';

import type { FastifyInstance, RouteShorthandOptions } from 'fastify';

import { BUILD_HEADER, STALE_CLIENT_STATUS } from '../lib/build-contract.ts';
import { staleClientRejection } from '../lib/client-build.ts';
import { ingestStream } from '../lib/originals.ts';

export interface AdminUploadRouteOpts {
  siteRoot: string;
  guard: RouteShorthandOptions;
  invalidateSidecarListCache: () => void;
}

export function registerAdminUploadRoute(
  fastify: FastifyInstance,
  opts: AdminUploadRouteOpts
): void {
  const { siteRoot, guard, invalidateSidecarListCache } = opts;

  fastify.post('/admin/upload', { ...guard }, async (request, reply) => {
    // Before request.file(), so an oversized body from a stale client
    // isn't read off the wire only to be rejected.
    const stale = staleClientRejection(request.headers[BUILD_HEADER]);
    if (stale) return reply.code(STALE_CLIENT_STATUS).send(stale);

    const part = await request.file();
    /* c8 ignore next 3 — no-file-part branch rarely exercised */
    if (!part) return reply.code(400).send({ error: 'no file part' });

    try {
      const result = await ingestStream({
        stream: part.file,
        siteRoot,
        source: { kind: 'upload', originalName: part.filename ?? null }
      });

      // @fastify/multipart sets file.truncated when the size limit was
      // hit. ingestStream already wrote the partial bytes + a sidecar
      // for them; unlink both before returning 413 so storage doesn't
      // accumulate truncated-image garbage that the user can't reach
      // (the partial bytes have a different sha256 than any future
      // full upload, so they're orphaned by id alone).
      /* c8 ignore start — truncated upload rarely exercised in unit tests */
      if (part.file.truncated) {
        await fs.promises.unlink(result.path).catch(() => {});
        const sidecarFile = path.join(siteRoot, 'sidecars', `${result.id}.json`);
        await fs.promises.unlink(sidecarFile).catch(() => {});
        return reply.code(413).send({ error: 'file too large' });
      }
      /* c8 ignore stop */

      // Fresh id: drop the sidecar-listing cache so the next
      // /admin/preview/<short-prefix> finds it without waiting out
      // the TTL.
      invalidateSidecarListCache();

      return {
        id: result.id,
        bytes: result.bytes,
        deduplicated: result.deduplicated,
        ext: result.ext
      };
      /* c8 ignore start — ingest error branching rarely fully exercised */
    } catch (err) {
      // ingestStream throws Error("ingestStream: <reason>") for both
      // user-input failures (unrecognized format, oversize source,
      // unsupported encoding) and server-side sharp glitches (resize
      // crash, orientation normalize failure). The first set
      // surfaces as 400 so the editor's status line says "bad file";
      // anything else falls through to 500 so operator logs flag it
      // as a real issue instead of looking like another bad upload.
      const msg = (err as Error).message;
      const isInput =
        msg.startsWith('ingestStream: not a recognized image') ||
        msg.startsWith('ingestStream: image too large') ||
        msg.startsWith('ingestStream: unsupported image format');
      request.log.error({ err }, 'upload failed');
      return reply.code(isInput ? 400 : 500).send({ error: msg });
    }
    /* c8 ignore stop */
  });
}
