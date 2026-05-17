// Read-only image-lookup routes for the editor:
//   GET /admin/preview/:id      → 302 to the public derivative URL
//   GET /admin/original/:id     → stream the master original bytes
//   GET /admin/sidecar/:id/meta → metadata + ops + redoStack
//
// Plus the short-prefix-id resolver and its TTL-cached sidecar listing.
// The cache is encapsulated; the parent (src/routes/admin.ts) calls
// makeImageLookupRoutes() and passes the returned `invalidate`
// callback to other routes that create new sidecars (URL import, file
// upload, gdrive/onedrive import) so the next /admin/preview/<short>
// sees the new id immediately.

import fs from 'node:fs';

import type { FastifyInstance, RouteShorthandOptions } from 'fastify';

import { cacheKey } from '../lib/hash.ts';
import { imageInfo } from '../lib/originals.ts';
import { listSidecarIds } from '../lib/posts.ts';
import type { OutputFormat } from '../lib/render.ts';
import { read as sidecarRead } from '../lib/sidecar.ts';
import { imageDimensions } from '../lib/widget-helpers.ts';
import { fallback as imageFallback } from '../widgets/figure.ts';
import { sidecarUpdatedAt } from './sidecar-base.ts';

/** Smallest source dimension the /img derivative pipeline accepts.
 * Mirrors the guard in src/routes/public.ts. Below this, /admin/preview
 * falls back to serving the original bytes — the editor needs to
 * display SOMETHING for tiny inputs, and a 422 derivative would
 * just show a broken image. */
const MIN_RENDER_DIM = 16;

/** Sidecar-list cache TTL. Short enough that a freshly-uploaded image
 * becomes findable by short prefix within a few seconds; long enough
 * that a post with many images doesn't scan the directory once per
 * request. */
const SIDECAR_LIST_TTL_MS = 5_000;

export interface ImageLookupRouteOpts {
  siteRoot: string;
  guard: RouteShorthandOptions;
}

/** Register the lookup routes and return an invalidator the parent
 * can pass to other routes that create new sidecars. */
export function registerImageLookupRoutes(
  fastify: FastifyInstance,
  opts: ImageLookupRouteOpts
): { invalidate: () => void } {
  const { siteRoot, guard } = opts;

  let cachedIds: string[] | null = null;
  let cachedAt = 0;
  function getKnownIdsCached(): string[] {
    const now = Date.now();
    if (cachedIds && now - cachedAt < SIDECAR_LIST_TTL_MS) return cachedIds;
    cachedIds = listSidecarIds(siteRoot);
    cachedAt = now;
    return cachedIds;
  }
  function invalidate(): void {
    cachedIds = null;
    cachedAt = 0;
  }

  fastify.get<{ Params: { id: string } }>(
    '/admin/preview/:id',
    { ...guard },
    async (req, reply) => {
      const { id } = req.params;
      if (!/^[0-9a-f]{6,64}$/.test(id)) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      let fullId = id;
      if (id.length !== 64) {
        const known = getKnownIdsCached();
        const matches = known.filter((k) => k.startsWith(id));
        if (matches.length !== 1) {
          return reply.code(404).send({ error: 'unknown or ambiguous id' });
        }
        fullId = matches[0] as string;
      }
      const sidecar = await sidecarRead(siteRoot, fullId);
      if (!sidecar) return reply.code(404).send({ error: 'no sidecar' });

      // Inputs too small for the derivative pipeline (1×1 test
      // fixtures, corrupt EXIF-claimed-0×0) would 422 on /img/.
      // Serve the original bytes directly instead — the editor
      // needs to display SOMETHING in the figure thumb.
      const dims = await imageDimensions(siteRoot, fullId, sidecar);
      if (dims.width < MIN_RENDER_DIM || dims.height < MIN_RENDER_DIM) {
        return reply.redirect(`/admin/original/${fullId}`, 302);
      }

      const ophash = cacheKey({
        originalId: fullId,
        ops: sidecar.ops as Parameters<typeof cacheKey>[0]['ops'],
        variant: { w: imageFallback.w },
        output: {
          format: imageFallback.format as OutputFormat,
          quality: imageFallback.quality
        }
      });
      return reply.redirect(`/img/${fullId}.${ophash}.${imageFallback.format}`, 302);
    }
  );

  // Stream the master original bytes. The editor's client-side canvas
  // pipeline downloads this once per editing session and re-applies ops
  // locally so live preview is round-trip-free. Browsers can't decode
  // every format Sharp can ingest (notably HEIC on most browsers); the
  // client falls back to /admin/preview/:id when decoding fails.
  fastify.get<{ Params: { id: string } }>(
    '/admin/original/:id',
    { ...guard },
    async (req, reply) => {
      const { id } = req.params;
      if (!/^[0-9a-f]{64}$/.test(id)) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const sidecar = await sidecarRead(siteRoot, id);
      if (!sidecar) return reply.code(404).send({ error: 'no sidecar' });

      const info = await imageInfo(siteRoot, id);
      if (!info) {
        return reply.code(404).send({ error: 'original missing' });
      }
      if (!info.format) {
        /* c8 ignore next -- imageInfo only returns null format on
           undecodable bytes; ingested originals always decode */
        return reply.code(500).send({ error: 'original is not decodable' });
      }

      const stat = await fs.promises.stat(info.path);

      // Originals are immutable (content-addressable by sha256). The 1y
      // cache + immutable directive lets the browser keep the bytes
      // across edits in the same session without revalidating.
      reply
        .header('Content-Type', formatContentType(info.format))
        .header('Content-Length', String(stat.size))
        .header('Cache-Control', 'private, max-age=31536000, immutable');
      return reply.send(fs.createReadStream(info.path));
    }
  );

  // Sidecar inspection: returns metadata + ops + redoStack so the
  // editor can populate its undo/redo UI on each session-start. The
  // redo stack is persisted on the sidecar (cheap JSON) so the
  // user's undo history survives reload and cross-session.
  fastify.get<{ Params: { id: string } }>(
    '/admin/sidecar/:id/meta',
    { ...guard },
    async (req, reply) => {
      const { id } = req.params;
      if (!/^[0-9a-f]{64}$/.test(id)) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const sidecar = await sidecarRead(siteRoot, id);
      if (!sidecar) return reply.code(404).send({ error: 'no sidecar' });
      // Dims + format come from the file (the source of truth); the
      // sidecar carries only the edit intent.
      const info = await imageInfo(siteRoot, id);
      return {
        width: info?.width ?? null,
        height: info?.height ?? null,
        format: info?.format ?? null,
        ops: sidecar.ops,
        redoStack: sidecar.redoStack ?? [],
        // The sidecar's updated_at the client adopts as its
        // edit-start baseline for the commitImageEdit
        // optimistic-concurrency guard (mirrors savePost's
        // updatedAt → meta.lastSyncedAt).
        updatedAt: sidecarUpdatedAt(siteRoot, id)
      };
    }
  );

  return { invalidate };
}

/** Map a Sharp/libvips format name to an HTTP Content-Type for serving
 * the original file. Limited to formats the ingest accepts. The rarely-
 * served formats (webp/avif/gif/tiff/heif/default) have trivial 1:1
 * mappings; coverage-marking them avoids dragging fixture images of
 * every format into the unit suite. */
function formatContentType(fmt: string): string {
  switch (fmt) {
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    /* c8 ignore start -- trivial 1:1 mapping; tested via integration
       once a fixture exists for each format */
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'gif':
      return 'image/gif';
    case 'tiff':
      return 'image/tiff';
    case 'heif':
      return 'image/heif';
    default:
      return 'application/octet-stream';
    /* c8 ignore stop */
  }
}
