// GET /video/:filename and GET /video/poster/:filename — derivative
// video + poster, on Apache cache-miss fall-through.
//
// Apache rewrites /video/* straight to cache/video when the file is
// present (implementation.md §7); only on a miss does the request fall
// through here. Mirror of public-img.ts: render synchronously within a
// wall-clock budget, 202 + client retry past it, and Range/206 for the
// byte-seeking <video> element. The poster ophash includes the poster
// time, so a URL only ever validates against one specific derivative.

import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Db } from '../lib/db.ts';
import { enqueue, noteLiveRender } from '../lib/jobs.ts';
import { setPublicSecurityHeaders } from '../lib/security-headers.ts';
import { Semaphore } from '../lib/semaphore.ts';
import { videoDimensions } from '../lib/video-map-fs.ts';
import {
  renderVideoDerivative,
  type VideoDerivativeArgs,
  type VideoRenderResult,
  videoCachePaths
} from '../lib/video-render.ts';
import { readVideoSidecar, type VideoSidecar } from '../lib/video-sidecar.ts';

// Smallest source dimension the transcode pipeline will accept. ffmpeg
// refuses (or produces unusable output below) a handful of pixels; we
// reject up front with 422 so an absurd input doesn't become a 500 —
// same guard as public-img.ts.
const MIN_RENDER_DIM = 16;

const FILENAME_RE = /^([0-9a-f]{64})\.([0-9a-f]{12})\.(mp4)$/;
const POSTER_RE = /^([0-9a-f]{64})\.([0-9a-f]{12})\.(jpg|jpeg)$/;

export interface PublicVideoRoutesOpts {
  siteRoot: string;
  db: Db;
  /** Wall-clock budget for synchronous render on cache miss (ms). */
  renderBudgetMs: number;
}

/** True when `ophash` matches the current sidecar state. */
function findVideoMatch(
  siteRoot: string,
  sidecar: VideoSidecar,
  ophash: string,
  isPoster: boolean
): boolean {
  const p = videoCachePaths(siteRoot, sidecar.original, sidecar.ops, sidecar.poster.timeMs);
  return isPoster ? p.posterOphash === ophash : p.videoOphash === ophash;
}

function resolveInlineConcurrency(): number {
  const raw = process.env.RKR_INLINE_RENDER_CONCURRENCY;
  if (!raw) return 2;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

type RangeResult = { start: number; end: number } | 'invalid' | 'none';

/** Parse a single-range `bytes=` header. 'invalid' (→ 416) for
 * malformed or unsatisfiable ranges, 'none' when absent. */
function parseRange(header: string | undefined, size: number): RangeResult {
  if (header === undefined) return 'none';
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    // Suffix range: last N bytes.
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (size <= 0 || start >= size || start > end) return 'invalid';
  return { start, end };
}

function sendDerivative(
  reply: FastifyReply,
  filePath: string,
  contentType: string,
  rangeHeader: string | undefined
): FastifyReply {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    // The render reported success but the file is already gone — treat
    // as a failed render rather than streaming nothing.
    return reply.code(500).send({ error: 'render failed' });
  }
  const range = parseRange(rangeHeader, size);

  setPublicSecurityHeaders(reply);
  reply
    .type(contentType)
    .header('cache-control', 'public, max-age=31536000, immutable')
    .header('accept-ranges', 'bytes');

  if (range === 'invalid') {
    return reply.code(416).header('content-range', `bytes */${size}`).send();
  }
  if (range === 'none') {
    return reply.header('content-length', String(size)).send(fs.createReadStream(filePath));
  }
  const length = range.end - range.start + 1;
  return reply
    .code(206)
    .header('content-range', `bytes ${range.start}-${range.end}/${size}`)
    .header('content-length', String(length))
    .send(fs.createReadStream(filePath, { start: range.start, end: range.end }));
}

export function registerPublicVideoRoutes(
  fastify: FastifyInstance,
  opts: PublicVideoRoutesOpts
): void {
  const { siteRoot, db, renderBudgetMs } = opts;

  // Render dedup: concurrent requests for the same filename share one
  // renderVideoDerivative promise (which itself dedups the mp4+poster
  // pair across both routes). Same shape as public-img.ts.
  const inflightVideoRenders = new Map<string, Promise<VideoRenderResult>>();
  const renderSemaphore = new Semaphore(resolveInlineConcurrency());

  const handle = async (
    req: FastifyRequest<{ Params: { filename: string } }>,
    reply: FastifyReply,
    isPoster: boolean
  ): Promise<FastifyReply> => {
    const { filename } = req.params;
    const m = (isPoster ? POSTER_RE : FILENAME_RE).exec(filename);
    if (!m) {
      return reply.code(404).send({ error: 'bad filename' });
    }
    const originalId = m[1] as string;
    const ophash = m[2] as string;

    const sidecar = await readVideoSidecar(siteRoot, originalId);
    if (!sidecar) return reply.code(404).send({ error: 'unknown original' });

    // Stale URL: the sidecar's ops/poster changed since this ophash was
    // minted. 404, not a redirect — the widget re-emits the current
    // URL on the next render.
    if (!findVideoMatch(siteRoot, sidecar, ophash, isPoster)) {
      return reply.code(404).send({ error: 'no matching derivative' });
    }

    const dims = videoDimensions(sidecar);
    if (dims.width < MIN_RENDER_DIM || dims.height < MIN_RENDER_DIM) {
      return reply.code(422).send({
        error: 'input too small to derive a derivative',
        width: dims.width,
        height: dims.height,
        min: MIN_RENDER_DIM
      });
    }

    const args: VideoDerivativeArgs = {
      originalId,
      ops: sidecar.ops,
      posterTimeMs: sidecar.poster.timeMs,
      siteRoot
    };

    // Dedup: if a render for this filename is already in flight, await
    // the same promise. The map entry is cleared on settle so the next
    // cache-miss request re-enters renderVideoDerivative (which itself
    // short-circuits on cache hit). The live-render gauge + the
    // semaphore slot are taken only by the originating request —
    // duplicate awaiters ride along.
    let renderPromise = inflightVideoRenders.get(filename);
    if (!renderPromise && inflightVideoRenders.size >= 64) {
      return reply.code(503).header('retry-after', '5').send({ status: 'busy' });
    }
    if (!renderPromise) {
      noteLiveRender(1);
      renderPromise = (async () => {
        await renderSemaphore.acquire();
        try {
          return await renderVideoDerivative(args);
        } finally {
          renderSemaphore.release();
        }
      })().finally(() => {
        inflightVideoRenders.delete(filename);
        noteLiveRender(-1);
      });
      inflightVideoRenders.set(filename, renderPromise);
      // Suppress unhandled-rejection when the timeout path sends 202 and
      // the render later fails — the primary awaiter's catch won't run.
      renderPromise.catch((_err: unknown) => {});
    }

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), renderBudgetMs);
    });

    let result: Awaited<typeof renderPromise> | 'timeout';
    try {
      result = await Promise.race([renderPromise, timeoutPromise]);
    } catch (err) {
      if (timer) clearTimeout(timer);
      req.log.error({ err, filename }, 'video render failed');
      return reply.code(500).send({ error: 'render failed' });
    }
    if (timer) clearTimeout(timer);

    if (result === 'timeout') {
      // The in-flight renderPromise stays alive in inflightVideoRenders;
      // the next requester awaits it and serves from cache once it
      // lands. Enqueue too so a background worker can finish if every
      // requester gives up first.
      enqueue(db, { kind: 'renderVideo', payload: args, cacheKey: ophash });
      return reply.code(202).header('retry-after', '2').send({ status: 'rendering' });
    }

    return sendDerivative(
      reply,
      isPoster ? result.posterPath : result.videoPath,
      isPoster ? 'image/jpeg' : 'video/mp4',
      typeof req.headers.range === 'string' ? req.headers.range : undefined
    );
  };

  fastify.get<{ Params: { filename: string } }>(
    '/video/:filename',
    {
      // Anti-DoS: cap derivative renders per IP. Apache serves cache
      // hits directly, so this only bites on cache-miss requests —
      // same budget and rationale as /img.
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } }
    },
    (req, reply) => handle(req, reply, false)
  );
  fastify.get<{ Params: { filename: string } }>(
    '/video/poster/:filename',
    {
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } }
    },
    (req, reply) => handle(req, reply, true)
  );
}
