// Public routes:
//   GET /                — paginated index of published posts
//   GET /:slug           — rendered post page
//   GET /img/:filename   — derivative image, on Apache cache-miss fall-through
//
// Apache rewrites /img/* directly to the cache file when present (spec §14);
// only on miss does it fall through here.

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { readIndexedPostBySlug, readIndexedPosts } from '../cli/reindex.ts';
import { type SiteConfig, siteConfig } from '../lib/config.ts';
import { parsePost, renderPostHtml } from '../lib/content.ts';
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
import { WidgetRegistry } from '../lib/widgets.ts';
import { renderIndexPage } from '../templates/index.ts';
import { renderPostPage } from '../templates/post.ts';
import carouselWidget from '../widgets/carousel.ts';
import { diptychWidget, triptychWidget } from '../widgets/diptych.ts';
import galleryWidget from '../widgets/gallery.ts';
import imageWidget from '../widgets/image.ts';

const FILENAME_RE = /^([0-9a-f]{64})\.([0-9a-f]{12})\.(webp|avif|jpeg|jpg|png)$/;
const PAGE_SIZE = 20;

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
  /** Override site branding (title/tagline). Default reads from env. */
  site?: SiteConfig;
}

export default async function publicRoutes(
  fastify: FastifyInstance,
  opts: PublicRoutesOpts
): Promise<void> {
  const { siteRoot, db, renderBudgetMs = 30_000 } = opts;
  const site = opts.site ?? siteConfig();

  const widgets = new WidgetRegistry();
  widgets.register(imageWidget);
  widgets.register(galleryWidget);
  widgets.register(carouselWidget);
  widgets.register(diptychWidget);
  widgets.register(triptychWidget);

  // ---- index: GET / -----------------------------------------------------

  fastify.get<{ Querystring: { page?: string } }>('/', async (req, reply) => {
    const requested = Number.parseInt(req.query.page ?? '1', 10);
    const page = Number.isFinite(requested) && requested >= 1 ? requested : 1;
    const offset = (page - 1) * PAGE_SIZE;

    const total = (
      db
        .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM posts WHERE status = 'published'")
        .get() ?? { n: 0 }
    ).n;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const rows = readIndexedPosts(db, { limit: PAGE_SIZE, offset, status: 'published' });
    const html = renderIndexPage({
      site,
      page,
      totalPages,
      posts: rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        ...(r.published_at ? { date: r.published_at } : {})
      }))
    });

    return reply.type('text/html; charset=utf-8').send(html);
  });

  // ---- post: GET /:slug -------------------------------------------------

  fastify.get<{ Params: { slug: string } }>('/:slug', async (req, reply) => {
    const { slug } = req.params;
    const row = readIndexedPostBySlug(db, slug);
    if (!row || row.status !== 'published') {
      return reply.code(404).type('text/html').send('<h1>not found</h1>');
    }

    const fullPath = path.join(siteRoot, row.path);
    const raw = await fs.promises.readFile(fullPath, 'utf8');
    const parsed = parsePost(raw);
    const bodyHtml = await renderPostHtml(parsed.ast, { siteRoot, widgets });

    const html = renderPostPage({
      site,
      title: parsed.frontmatter.title,
      slug: parsed.frontmatter.slug,
      ...(parsed.frontmatter.date ? { date: parsed.frontmatter.date } : {}),
      bodyHtml
    });

    return reply.type('text/html; charset=utf-8').send(html);
  });

  // ---- derivative image: GET /img/:filename -----------------------------

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
      enqueue(db, { kind: 'render', payload: args, cacheKey: ophash });
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
