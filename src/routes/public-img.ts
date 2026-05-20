// GET /img/:filename — derivative image, on Apache cache-miss fall-through.
//
// Apache rewrites /img/* directly to the cache file when present
// (implementation.md §7); only on miss does it fall through here.
// On miss this route synchronously renders the derivative within a
// wall-clock budget; past that it returns 202 and the client retries.

import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';

import type { Db } from '../lib/db.ts';
import { cacheKey } from '../lib/hash.ts';
import { enqueue, noteLiveRender } from '../lib/jobs.ts';
import {
  type DerivativeArgs,
  type Op,
  type OutputFormat,
  type RenderResult,
  renderDerivative
} from '../lib/render.ts';
import { setPublicSecurityHeaders } from '../lib/security-headers.ts';
import { Semaphore } from '../lib/semaphore.ts';
import { read as sidecarRead } from '../lib/sidecar.ts';
import type { Sidecar } from '../lib/sidecar-types.ts';
import { imageDimensions } from '../lib/widget-helpers.ts';

// Smallest source dimension the derivative pipeline will accept.
// Sharp + the encoders (mozjpeg, libwebp, libavif) refuse or produce
// unusable output below a handful of pixels; we reject up front with
// 422 so an absurd input ("synthetic 1×1 PNG smoke fixture", corrupt
// EXIF that lies the image is 0×0) doesn't become a 500.
const MIN_RENDER_DIM = 16;

const FILENAME_RE = /^([0-9a-f]{64})\.([0-9a-f]{12})\.(webp|avif|jpeg|jpg|png)$/;

const MIME: Record<OutputFormat, string> = {
  webp: 'image/webp',
  avif: 'image/avif',
  jpeg: 'image/jpeg',
  png: 'image/png'
};

export interface PublicImgRoutesOpts {
  siteRoot: string;
  db: Db;
  /** Wall-clock budget for synchronous render on cache miss (ms). */
  renderBudgetMs: number;
}

interface VariantOutputMatch {
  variant: DerivativeArgs['variant'];
  output: DerivativeArgs['output'];
}

function findVariantOutput(sidecar: Sidecar, ophash: string): VariantOutputMatch | null {
  for (const variant of sidecar.variants) {
    for (const output of sidecar.outputs) {
      const v = { w: variant.w, h: variant.h, fit: variant.fit } as DerivativeArgs['variant'];
      const o = {
        format: output.format as OutputFormat,
        quality: output.quality
      } as DerivativeArgs['output'];
      const k = cacheKey({
        originalId: sidecar.original,
        ops: sidecar.ops as never,
        variant: v as never,
        output: o as never
      });
      if (k === ophash) return { variant: v, output: o };
    }
  }
  return null;
}

function resolveInlineConcurrency(): number {
  const raw = process.env.RKR_INLINE_RENDER_CONCURRENCY;
  if (!raw) return 2;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

export function registerPublicImgRoutes(fastify: FastifyInstance, opts: PublicImgRoutesOpts): void {
  const { siteRoot, db, renderBudgetMs } = opts;

  // Render dedup: concurrent /img requests for the same filename
  // share one renderDerivative promise instead of starting parallel
  // sharp pipelines. Halves CPU on bursts where a browser kicks off
  // many parallel image fetches for the same variant URL (or two
  // browsers hit the same article at the same time).
  const inflightRenders = new Map<string, Promise<RenderResult>>();

  // Inline-render concurrency cap. Without this, a 30-image post
  // opening in a browser fires 30 simultaneous renderDerivative
  // calls; with sharp.concurrency(1) that's 30 libvips threads
  // context-switching on whatever CPU the fly machine has. Default
  // 2 is right for a single-vCPU box; override via
  // RKR_INLINE_RENDER_CONCURRENCY for larger machines.
  const renderSemaphore = new Semaphore(resolveInlineConcurrency());

  // ---- derivative image: GET /img/:filename -----------------------------

  fastify.get<{ Params: { filename: string } }>(
    '/img/:filename',
    {
      // Anti-DoS: cap derivative renders per IP. Apache serves cache
      // hits directly (implementation.md §7), so this only bites on
      // cache-miss requests hitting Fastify. A long article can have
      // 30+ images and the client now retries indefinitely with up
      // to 10s spacing, so a single user can sustain ~30 + ~6/min/img
      // requests easily. 600/min/IP keeps abuse-bursts at 429 while
      // accommodating a real reader on a slow render queue.
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } }
    },
    async (req, reply) => {
      const { filename } = req.params;
      const m = FILENAME_RE.exec(filename);
      if (!m) {
        return reply.code(404).send({ error: 'bad filename' });
      }
      const originalId = m[1] as string;
      const ophash = m[2] as string;
      const fmtRaw = m[3] as string;
      const format: OutputFormat = fmtRaw === 'jpg' ? 'jpeg' : (fmtRaw as OutputFormat);

      const sidecar = await sidecarRead(siteRoot, originalId);
      if (!sidecar) return reply.code(404).send({ error: 'unknown original' });

      const match = findVariantOutput(sidecar, ophash);
      if (!match) return reply.code(404).send({ error: 'no matching variant' });

      // Reject inputs too small to derive a useful variant from.
      // Cheaper than letting sharp throw mid-pipeline and serving 500
      // — and gives clients a deterministic 422 they can suppress
      // rather than spamming retries against.
      const dims = await imageDimensions(siteRoot, originalId, sidecar);
      if (dims.width < MIN_RENDER_DIM || dims.height < MIN_RENDER_DIM) {
        return reply.code(422).send({
          error: 'input too small to derive a variant',
          width: dims.width,
          height: dims.height,
          min: MIN_RENDER_DIM
        });
      }

      const args: DerivativeArgs & { siteRoot: string } = {
        originalId,
        ops: sidecar.ops as Op[],
        variant: match.variant,
        output: { ...match.output, format },
        siteRoot
      };

      // Dedup: if a render for this filename is already in flight,
      // await the same promise. The map entry is cleared on settle
      // so the next cache-miss request re-enters renderDerivative
      // (which itself short-circuits on cache hit). The live-render
      // gauge + the semaphore slot are taken only by the
      // originating request — duplicate awaiters ride along.
      let renderPromise = inflightRenders.get(filename);
      if (!renderPromise && inflightRenders.size >= 64) {
        return reply.code(503).header('retry-after', '5').send({ status: 'busy' });
      }
      if (!renderPromise) {
        noteLiveRender(1);
        renderPromise = (async () => {
          await renderSemaphore.acquire();
          try {
            return await renderDerivative(args);
          } finally {
            renderSemaphore.release();
          }
        })().finally(() => {
          inflightRenders.delete(filename);
          noteLiveRender(-1);
        });
        inflightRenders.set(filename, renderPromise);
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
        req.log.error({ err, filename }, 'render failed');
        return reply.code(500).send({ error: 'render failed' });
      }
      if (timer) clearTimeout(timer);

      if (result === 'timeout') {
        // The in-flight renderPromise stays alive in inflightRenders;
        // the next requester will await the same promise and serve
        // from the cache once it lands. Enqueue too so a background
        // worker can finish if every requester gives up first.
        enqueue(db, { kind: 'render', payload: args, cacheKey: ophash });
        return reply.code(202).send({ status: 'rendering' });
      }

      setPublicSecurityHeaders(reply);
      return reply
        .type(MIME[format])
        .header('content-length', String(result.bytes))
        .send(fs.createReadStream(result.path));
    }
  );
}
