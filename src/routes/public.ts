// Public routes that need to be reachable on cache miss.
// Apache rewrites /img/* directly to the cache file when present (spec §14);
// only on miss does it fall through to Fastify, who renders the derivative
// and writes it under cache/img/.

import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';

import type { Db } from '../lib/db.ts';
import { cacheKey } from '../lib/hash.ts';
import { enqueue } from '../lib/jobs.ts';
import {
  type DerivativeArgs,
  type Op,
  type OutputFormat,
  renderDerivative
} from '../lib/render.ts';
import { type Sidecar, read as sidecarRead } from '../lib/sidecar.ts';

const FILENAME_RE = /^([0-9a-f]{64})\.([0-9a-f]{12})\.(webp|avif|jpeg|jpg|png)$/;

const MIME: Record<OutputFormat, string> = {
  webp: 'image/webp',
  avif: 'image/avif',
  jpeg: 'image/jpeg',
  png: 'image/png'
};

export interface PublicRoutesOpts {
  siteRoot: string;
  db: Db;
  /** Wall-clock budget for synchronous render on cache miss (ms). */
  renderBudgetMs?: number;
}

export default async function publicRoutes(
  fastify: FastifyInstance,
  opts: PublicRoutesOpts
): Promise<void> {
  const { siteRoot, db, renderBudgetMs = 30_000 } = opts;

  fastify.get<{ Params: { filename: string } }>('/img/:filename', async (req, reply) => {
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

    const args: DerivativeArgs & { siteRoot: string } = {
      originalId,
      ops: sidecar.ops as Op[],
      variant: match.variant,
      output: { ...match.output, format },
      siteRoot
    };

    const renderPromise = renderDerivative(args);
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
      // Make sure the worker eventually finishes the job; idempotent.
      enqueue(db, {
        kind: 'render',
        payload: args,
        cacheKey: ophash
      });
      // Don't leave the in-flight render unhandled.
      renderPromise.catch((err: unknown) => {
        req.log.warn({ err, filename }, 'background render error');
      });
      return reply.code(202).send({ status: 'rendering' });
    }

    return reply
      .type(MIME[format])
      .header('content-length', String(result.bytes))
      .send(fs.createReadStream(result.path));
  });
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
