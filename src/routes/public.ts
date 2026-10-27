// Public routes:
//   GET /, /posts        — paginated index of published posts (public-index.ts)
//   GET /:slug           — rendered post page
//   GET /img/:filename   — derivative image, on Apache cache-miss fall-through
//
// Apache rewrites /img/* directly to the cache file when present
// (implementation.md §7); only on miss does it fall through here.

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type SiteConfig, siteConfig } from '../lib/config.ts';
import { parsePost, renderPostHtml } from '../lib/content.ts';
import type { Db } from '../lib/db.ts';
import { buildImageMap } from '../lib/image-map-fs.ts';
import { readIndexedPostBySlug } from '../lib/post-index.ts';
import { setPublicSecurityHeaders } from '../lib/security-headers.ts';
import { serverAssets } from '../lib/site-assets.ts';
import { loadChrome } from '../lib/site-chrome.ts';
import { homePageRow } from '../lib/site-org-settings.ts';
import { extractPostBanner, renderStoredPage } from '../lib/stored-page-render.ts';
import { buildVideoMap } from '../lib/video-map-fs.ts';
import { WidgetRegistry } from '../lib/widgets.ts';
import { renderNotFoundPage } from '../templates/not-found.ts';
import { renderPostPage } from '../templates/post.ts';
import figureWidget from '../widgets/figure.ts';
import videoWidget from '../widgets/video.ts';
import { registerPublicCommentRoutes } from './public-comments.ts';
import { registerPublicImgRoutes } from './public-img.ts';
import { registerIndexRoutes } from './public-index.ts';
import { registerPublicSearchRoute } from './public-search.ts';
import { registerPublicVideoRoutes } from './public-video.ts';

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
  // 8s default keeps the /img response well under the reverse-proxy
  // (Apache) timeout — past that the proxy returns 502 instead of
  // waiting for the route's 202 fallback. Cold-cache renders that
  // exceed 8s (rare, mostly AVIF on big sources) take the 202 path;
  // img-retry.js
  // polls back with backoff until the cache lands.
  const { siteRoot, db, renderBudgetMs = 8_000 } = opts;
  const getSite = (): SiteConfig => opts.site ?? siteConfig();

  const send404 = async (req: FastifyRequest, reply: FastifyReply) => {
    const isAdmin = !!req.user;
    const site = getSite();
    const chrome = await loadChrome(siteRoot, site, req.log);
    setPublicSecurityHeaders(reply);
    if (isAdmin) reply.header('Cache-Control', 'private, no-store');
    return reply
      .code(404)
      .type('text/html; charset=utf-8')
      .send(renderNotFoundPage({ site, isAdmin, assets: serverAssets(), chrome }));
  };

  const widgets = new WidgetRegistry();
  // ::figure is the only image widget (spec.md §9 unification); ::video
  // is the self-hosted video widget (video spec §5). Any older ::image /
  // ::gallery / ::carousel / ::diptych / ::triptych on disk renders as a
  // `<!-- unknown widget -->` placeholder; the WP importer emits ::figure
  // directly.
  widgets.register(figureWidget);
  widgets.register(videoWidget);
  registerPublicCommentRoutes(fastify, { db });
  registerPublicImgRoutes(fastify, { siteRoot, db, renderBudgetMs });
  registerPublicVideoRoutes(fastify, { siteRoot, db, renderBudgetMs });
  registerIndexRoutes(fastify, { siteRoot, db, getSite, widgets });

  // ---- about: GET /about -----------------------------------------------

  // GET /about — a published block page with slug `about` (any status for
  // admins), else the _about system post rendered as a standalone page.
  // _-slugs are 404 via /:slug by design, so the fallback reads the file
  // directly and renders without comments.
  fastify.get('/about', async (req, reply) => {
    const site = getSite();
    const isAdmin = !!req.user;
    const aboutRow = readIndexedPostBySlug(db, 'about');
    if (aboutRow && (aboutRow.status === 'published' || isAdmin)) {
      const html = await renderStoredPage({
        siteRoot,
        db,
        row: aboutRow,
        site,
        widgets,
        isAdmin,
        log: req.log
      });
      setPublicSecurityHeaders(reply);
      if (isAdmin) reply.header('Cache-Control', 'private, no-store');
      return reply.type('text/html; charset=utf-8').send(html);
    }
    const filePath = path.join(siteRoot, 'content', 'posts', '_about.md');
    let parsed: ReturnType<typeof parsePost>;
    try {
      parsed = parsePost(await fs.promises.readFile(filePath, 'utf8'));
    } catch {
      return send404(req, reply);
    }
    const ctx = {
      images: await buildImageMap(siteRoot, parsed.ast, { log: req.log }),
      videos: await buildVideoMap(siteRoot),
      widgets
    };
    const bannerHtml = await extractPostBanner(parsed.ast, ctx);
    const bodyHtml = await renderPostHtml(parsed.ast, ctx);
    setPublicSecurityHeaders(reply);
    if (isAdmin) reply.header('Cache-Control', 'private, no-store');
    return reply.type('text/html; charset=utf-8').send(
      renderPostPage({
        site,
        assets: serverAssets(),
        chrome: await loadChrome(siteRoot, site, req.log),
        title: parsed.frontmatter.title,
        slug: '_about',
        bodyHtml,
        isAdmin,
        showComments: false,
        ...(bannerHtml ? { bannerHtml } : {}),
        ...(site.bannerAboveHeader ? { bannerAboveHeader: true } : {})
      })
    );
  });

  // ---- search: GET /search ---------------------------------------------

  registerPublicSearchRoute(fastify, { siteRoot, db, getSite });

  // ---- post: GET /:slug -------------------------------------------------

  fastify.get<{ Params: { slug: string }; Querystring: { submitted?: string } }>(
    '/:slug',
    async (req, reply) => {
      const site = getSite();
      const { slug } = req.params;
      // _-prefixed slugs are system posts (e.g. _site-banner); they are
      // never indexed and must never be directly accessible via the public
      // route — return 404 unconditionally, even for authenticated users.
      if (slug.startsWith('_')) return send404(req, reply);
      // The home page lives at /. Only a published page redirects, since a
      // 301 is cached permanently.
      if (homePageRow(db, site)?.slug === slug) {
        setPublicSecurityHeaders(reply);
        return reply.redirect('/', 301);
      }
      const row = readIndexedPostBySlug(db, slug);
      // Authed visitors see drafts (matches the index page, which links
      // drafts straight to /:slug from the admin table). Anonymous
      // visitors keep the published-only filter.
      if (!row || (row.status !== 'published' && !req.user)) return send404(req, reply);

      const html = await renderStoredPage({
        siteRoot,
        db,
        row,
        site,
        widgets,
        isAdmin: !!req.user,
        log: req.log,
        submitted: req.query.submitted === '1'
      });

      setPublicSecurityHeaders(reply);
      if (req.user) reply.header('Cache-Control', 'private, no-store');
      return reply.type('text/html; charset=utf-8').send(html);
    }
  );

  // ---- legacy WordPress permalinks: GET /:y/:m/:d/:slug ------------------

  // Both migrated sites used /%year%/%monthnum%/%day%/%postname%/ and the
  // import preserved slugs, so a 301 keeps in-content and inbound links
  // alive. Drafts and system posts do not redirect: a 301 is cached
  // permanently by browsers, so it must only ever point at a URL that is
  // public for everyone.
  const legacyPermalink = async (
    req: FastifyRequest<{ Params: { y: string; m: string; d: string; slug: string } }>,
    reply: FastifyReply
  ) => {
    const { y, m, d, slug } = req.params;
    if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) {
      return send404(req, reply);
    }
    const row = readIndexedPostBySlug(db, slug);
    if (!row || row.status !== 'published' || slug.startsWith('_')) return send404(req, reply);
    setPublicSecurityHeaders(reply);
    return reply.redirect(`/${encodeURIComponent(slug)}`, 301);
  };
  fastify.get('/:y/:m/:d/:slug', legacyPermalink);
  fastify.get('/:y/:m/:d/:slug/', legacyPermalink);
}
