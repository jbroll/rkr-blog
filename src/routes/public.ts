// Public routes:
//   GET /                — paginated index of published posts
//   GET /:slug           — rendered post page
//   GET /img/:filename   — derivative image, on Apache cache-miss fall-through
//
// Apache rewrites /img/* directly to the cache file when present
// (implementation.md §7); only on miss does it fall through here.

// Public-page security headers. CSP is intentionally tight: posts
// don't need third-party scripts, images, or styles. The site-wide
// JS (lightbox + carousel) is bundled and served from /static. The
// markdown renderer passes through raw HTML in posts (single-author
// trust); CSP+nosniff narrow the blast radius if a content mistake
// or future external-import path lets something through.
const PUBLIC_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join('; ');

function setPublicSecurityHeaders(reply: import('fastify').FastifyReply): void {
  reply.header('Content-Security-Policy', PUBLIC_CSP);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  // X-Frame-Options is redundant with frame-ancestors for modern
  // browsers but cheap insurance for old crawlers + WAF heuristics.
  reply.header('X-Frame-Options', 'DENY');
}

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { readIndexedPostBySlug, readIndexedPosts } from '../cli/reindex.ts';
import { type SiteConfig, siteConfig } from '../lib/config.ts';
import { parsePost, renderPostHtml } from '../lib/content.ts';
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
import { Semaphore } from '../lib/semaphore.ts';
import { read as sidecarRead } from '../lib/sidecar.ts';
import type { Sidecar } from '../lib/sidecar-types.ts';
import { WidgetRegistry } from '../lib/widgets.ts';
import { renderIndexPage } from '../templates/index.ts';
import { renderNotFoundPage } from '../templates/not-found.ts';
import { renderPostPage } from '../templates/post.ts';
import figureWidget from '../widgets/figure.ts';

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

  const widgets = new WidgetRegistry();
  // ::figure is the only image widget (spec.md §9 unification).
  // The figure widget is the only image directive recognised by the
  // public renderer. Any older ::image / ::gallery / ::carousel /
  // ::diptych / ::triptych on disk renders as a `<!-- unknown widget -->`
  // placeholder; the WP importer emits ::figure directly.
  widgets.register(figureWidget);

  // ---- index: GET / -----------------------------------------------------

  fastify.get<{ Querystring: { page?: string } }>('/', async (req, reply) => {
    const requested = Number.parseInt(req.query.page ?? '1', 10);
    const page = Number.isFinite(requested) && requested >= 1 ? requested : 1;
    const offset = (page - 1) * PAGE_SIZE;
    const isAdmin = !!req.user;
    // Authed visitors see drafts + published (the homepage doubles as
    // the admin posts list). Anonymous visitors keep the published-
    // only filter so drafts stay invisible until promotion.
    const countSql = isAdmin
      ? 'SELECT COUNT(*) AS n FROM posts'
      : "SELECT COUNT(*) AS n FROM posts WHERE status = 'published'";
    const total = (db.prepare<{ n: number }>(countSql).get() ?? { n: 0 }).n;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const rows = readIndexedPosts(db, {
      limit: PAGE_SIZE,
      offset,
      status: isAdmin ? null : 'published'
    });
    const html = renderIndexPage({
      site,
      page,
      totalPages,
      posts: rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        ...(r.published_at ? { date: r.published_at } : {}),
        ...(isAdmin ? { status: r.status, updatedAt: r.updated_at } : {})
      })),
      isAdmin
    });

    setPublicSecurityHeaders(reply);
    // Authed responses carry session-private chrome (admin strip,
    // per-row controls). Mark them no-store so the SW + any HTTP
    // intermediary skip caching — a post-action 303 redirect to /
    // would otherwise serve the previously-cached pre-action body.
    if (isAdmin) reply.header('Cache-Control', 'private, no-store');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // ---- post: GET /:slug -------------------------------------------------

  fastify.get<{ Params: { slug: string } }>('/:slug', async (req, reply) => {
    const { slug } = req.params;
    const row = readIndexedPostBySlug(db, slug);
    // Authed visitors see drafts (matches the index page, which links
    // drafts straight to /:slug from the admin table). Anonymous
    // visitors keep the published-only filter.
    if (!row || (row.status !== 'published' && !req.user)) {
      setPublicSecurityHeaders(reply);
      const isAdmin = !!req.user;
      if (isAdmin) reply.header('Cache-Control', 'private, no-store');
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(renderNotFoundPage({ site, isAdmin }));
    }

    const fullPath = path.join(siteRoot, row.path);
    const raw = await fs.promises.readFile(fullPath, 'utf8');
    const parsed = parsePost(raw);
    const bodyHtml = await renderPostHtml(parsed.ast, { siteRoot, widgets });

    const html = renderPostPage({
      site,
      title: parsed.frontmatter.title,
      ...(typeof parsed.frontmatter.subtitle === 'string' && parsed.frontmatter.subtitle.trim()
        ? { subtitle: parsed.frontmatter.subtitle }
        : {}),
      slug: parsed.frontmatter.slug,
      ...(parsed.frontmatter.date ? { date: parsed.frontmatter.date } : {}),
      bodyHtml,
      isAdmin: !!req.user
    });

    setPublicSecurityHeaders(reply);
    if (req.user) reply.header('Cache-Control', 'private, no-store');
    return reply.type('text/html; charset=utf-8').send(html);
  });

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

      return reply
        .type(MIME[format])
        .header('content-length', String(result.bytes))
        .send(fs.createReadStream(result.path));
    }
  );
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
