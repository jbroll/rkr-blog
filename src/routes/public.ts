// Public routes:
//   GET /                — paginated index of published posts
//   GET /:slug           — rendered post page
//   GET /img/:filename   — derivative image, on Apache cache-miss fall-through
//
// Apache rewrites /img/* directly to the cache file when present
// (implementation.md §7); only on miss does it fall through here.

// snippet() wraps matches in sentinel chars (from the SQL char(1) /
// char(2) args = U+0001 / U+0002). Escape the whole string FIRST,
// THEN swap the (escaping-untouched) sentinels for <mark> — a literal
// "<mark>" in body text cannot be injected.
const SNIP_OPEN = String.fromCharCode(1);
const SNIP_CLOSE = String.fromCharCode(2);
function highlightSnippet(snip: string): string {
  return escapeText(snip).split(SNIP_OPEN).join('<mark>').split(SNIP_CLOSE).join('</mark>');
}

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Paragraph, Root, RootContent } from 'mdast';
import type { LeafDirective } from 'mdast-util-directive';
import { getPostIdBySlug, listPublishedThread } from '../lib/comments.ts';
import { type SiteConfig, siteConfig } from '../lib/config.ts';
import { escapeText, parsePost, renderPostHtml } from '../lib/content.ts';
import type { Db } from '../lib/db.ts';
import { readIndexedPostBySlug, readIndexedPosts, readTagCounts } from '../lib/post-index.ts';
import { buildFtsMatch } from '../lib/search-query.ts';
import { setPublicSecurityHeaders } from '../lib/security-headers.ts';
import { truncateParagraph } from '../lib/teaser-truncate.ts';
import { type DirectiveNode, WidgetRegistry } from '../lib/widgets.ts';
import { COMMENT_SUBMITTED_NOTICE } from '../templates/comments.ts';
import { type IndexTeaser, renderIndexPage } from '../templates/index.ts';
import { renderNotFoundPage } from '../templates/not-found.ts';
import { renderPostPage } from '../templates/post.ts';
import { renderSearchPage, type SearchHit } from '../templates/search.ts';
import figureWidget from '../widgets/figure.ts';
import { registerPublicCommentRoutes } from './public-comments.ts';
import { registerPublicImgRoutes } from './public-img.ts';

export interface PublicRoutesOpts {
  siteRoot: string;
  db: Db;
  /** Wall-clock budget for synchronous render on cache miss (ms). */
  renderBudgetMs?: number;
  /** Override site branding (title/tagline). Default reads from env. */
  site?: SiteConfig;
}

/** If the post AST's first non-yaml node is a ::figure leafDirective,
 * splice it out and return its rendered HTML. The directive's own
 * attributes (justify, aspect, etc.) are preserved verbatim so the
 * author controls the banner appearance by editing the markdown.
 * Returns null when the first element is anything else. */
async function extractPostBanner(
  ast: Root,
  ctx: { siteRoot: string; widgets: WidgetRegistry }
): Promise<string | null> {
  let firstIdx = -1;
  for (let i = 0; i < ast.children.length; i++) {
    if (ast.children[i]?.type !== 'yaml') {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return null;
  const first = ast.children[firstIdx] as RootContent;
  if (first.type !== 'leafDirective') return null;
  const dir = first as unknown as DirectiveNode;
  if (dir.name !== 'figure') return null;

  const html = await ctx.widgets.dispatch('figure', dir, ctx);
  ast.children.splice(firstIdx, 1);
  return html;
}

/** First remaining top-level paragraph rendered to inline HTML (links /
 * emphasis preserved). Call AFTER extractPostBanner has spliced the hero
 * figure out, so "first paragraph" is the lede. Null when none. When
 * `maxWords > 0` the paragraph is word-truncated at the mdast layer
 * (markup-preserving) before rendering. */
async function extractFirstParagraph(
  ast: Root,
  ctx: { siteRoot: string; widgets: WidgetRegistry },
  maxWords: number
): Promise<string | null> {
  const para = ast.children.find((n) => n.type === 'paragraph');
  if (!para) return null;
  const trimmed = truncateParagraph(para as Paragraph, maxWords);
  return renderPostHtml({ type: 'root', children: [trimmed] }, ctx);
}

export default async function publicRoutes(
  fastify: FastifyInstance,
  opts: PublicRoutesOpts
): Promise<void> {
  // 8s default keeps the /img response well under Fly's ~20s edge
  // timeout — past that the platform returns 502 instead of waiting
  // for the route's 202 fallback. Cold-cache renders that exceed 8s
  // (rare, mostly AVIF on big sources) take the 202 path; img-retry.js
  // polls back with backoff until the cache lands.
  const { siteRoot, db, renderBudgetMs = 8_000 } = opts;
  const getSite = (): SiteConfig => opts.site ?? siteConfig();

  const widgets = new WidgetRegistry();
  // ::figure is the only image widget (spec.md §9 unification).
  // The figure widget is the only image directive recognised by the
  // public renderer. Any older ::image / ::gallery / ::carousel /
  // ::diptych / ::triptych on disk renders as a `<!-- unknown widget -->`
  // placeholder; the WP importer emits ::figure directly.
  widgets.register(figureWidget);
  registerPublicCommentRoutes(fastify, { db });
  registerPublicImgRoutes(fastify, { siteRoot, db, renderBudgetMs });

  // ---- index: GET / -----------------------------------------------------

  fastify.get<{ Querystring: { page?: string; tag?: string | string[]; sort?: string } }>(
    '/',
    async (req, reply) => {
      const site = getSite();
      const isAdmin = !!req.user;
      // Only one tag at a time (OR/replace logic). Fastify may deliver a
      // string or string[] for repeated params; take the first non-empty value.
      const rawTag = req.query.tag;
      const firstTag = (Array.isArray(rawTag) ? rawTag[0] : rawTag)?.trim();
      const activeTags = firstTag ? [firstTag] : [];
      const sort: 'asc' | 'desc' = req.query.sort === 'asc' ? 'asc' : 'desc';
      // Authed visitors see drafts + published (the homepage doubles as
      // the admin posts list). Anonymous visitors keep the published-
      // only filter so drafts stay invisible until promotion.
      const status: 'published' | null = isAdmin ? null : 'published';

      const total = countPosts(db, status, activeTags);

      const rows = readIndexedPosts(db, {
        limit: total,
        offset: 0,
        status,
        tags: activeTags,
        sort
      });

      // Tag rail: all posts for admin (drafts count too); published-only for anonymous.
      const tagCounts = readTagCounts(db, { status: isAdmin ? null : 'published' });

      let indexBannerHtml: string | undefined;

      // Prefer _site-banner.md: find the first ::figure leafDirective and
      // render it as the index banner. Falls back to bannerImageId if the
      // file is absent or contains no ::figure.
      const siteBannerPath = path.join(siteRoot, 'content', 'posts', '_site-banner.md');
      let siteBannerFigureFound = false;
      if (fs.existsSync(siteBannerPath)) {
        try {
          const raw = fs.readFileSync(siteBannerPath, 'utf8');
          const { ast } = parsePost(raw);
          const figureNode = ast.children.find(
            (n): n is LeafDirective =>
              n.type === 'leafDirective' && (n as LeafDirective).name === 'figure'
          ) as LeafDirective | undefined;
          if (figureNode) {
            siteBannerFigureFound = true;
            indexBannerHtml = await widgets.dispatch('figure', figureNode as DirectiveNode, {
              siteRoot,
              widgets
            });
          }
        } catch {
          // Malformed _site-banner.md — fall through to bannerImageId.
        }
      }

      if (!siteBannerFigureFound && site.bannerImageId) {
        const bannerNode: DirectiveNode = {
          type: 'leafDirective',
          name: 'figure',
          attributes: { ids: site.bannerImageId, justify: 'bleed' },
          children: []
        };
        indexBannerHtml = await widgets.dispatch('figure', bannerNode, { siteRoot, widgets });
      }

      // Teaser: anonymous view only, behind the postTeaser toggle.
      // Read the current top post, splice out its hero figure + first
      // paragraph (same renderer the _site-banner.md block above uses),
      // and drop that post from the list so it is not duplicated.
      // path already includes content/posts/ (reindex.ts), so join
      // directly onto siteRoot — same as the GET /:slug handler.
      let teaser: IndexTeaser | undefined;
      let listRows = rows;
      const top = rows[0];
      if (!isAdmin && site.postTeaser && top) {
        try {
          const rawTop = fs.readFileSync(path.join(siteRoot, top.path), 'utf8');
          const { ast } = parsePost(rawTop);
          const ctx = { siteRoot, widgets };
          const bannerHtml = await extractPostBanner(ast, ctx);
          const excerptHtml = bannerHtml
            ? await extractFirstParagraph(ast, ctx, site.teaserWords ?? 0)
            : null;
          if (bannerHtml && excerptHtml) {
            teaser = {
              slug: top.slug,
              title: top.title,
              ...(top.published_at ? { date: top.published_at } : {}),
              bannerHtml,
              excerptHtml
            };
            listRows = rows.slice(1);
          }
        } catch {
          // Unreadable / malformed top post → no teaser, full list.
        }
      }

      const html = renderIndexPage({
        site,
        page: 1,
        totalPages: 1,
        posts: listRows.map((r) => ({
          slug: r.slug,
          title: r.title,
          ...(r.published_at ? { date: r.published_at } : {}),
          ...(isAdmin ? { status: r.status, updatedAt: r.updated_at } : {})
        })),
        ...(indexBannerHtml ? { bannerHtml: indexBannerHtml } : {}),
        ...(site.bannerAboveHeader ? { bannerAboveHeader: true } : {}),
        ...(teaser ? { teaser } : {}),
        isAdmin,
        ...(tagCounts.length > 0 ? { tagCounts } : {}),
        ...(activeTags.length > 0 ? { activeTags } : {}),
        sort
      });

      setPublicSecurityHeaders(reply);
      // Authed responses carry session-private chrome (admin strip,
      // per-row controls). Mark them no-store so the SW + any HTTP
      // intermediary skip caching — a post-action 303 redirect to /
      // would otherwise serve the previously-cached pre-action body.
      if (isAdmin) reply.header('Cache-Control', 'private, no-store');
      return reply.type('text/html; charset=utf-8').send(html);
    }
  );

  // ---- about: GET /about -----------------------------------------------

  // GET /about — the _about system post rendered as a standalone page.
  // _-slugs are 404 via /:slug by design, so this reads the file
  // directly and renders without comments.
  fastify.get('/about', async (req, reply) => {
    const site = getSite();
    const isAdmin = !!req.user;
    const filePath = path.join(siteRoot, 'content', 'posts', '_about.md');
    const send404 = () => {
      setPublicSecurityHeaders(reply);
      if (isAdmin) reply.header('Cache-Control', 'private, no-store');
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(renderNotFoundPage({ site, isAdmin }));
    };
    let parsed: ReturnType<typeof parsePost>;
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      parsed = parsePost(raw);
    } catch {
      return send404();
    }
    const ctx = { siteRoot, widgets };
    const bannerHtml = await extractPostBanner(parsed.ast, ctx);
    const bodyHtml = await renderPostHtml(parsed.ast, ctx);
    setPublicSecurityHeaders(reply);
    if (isAdmin) reply.header('Cache-Control', 'private, no-store');
    return reply.type('text/html; charset=utf-8').send(
      renderPostPage({
        site,
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

  fastify.get<{ Querystring: { q?: string } }>('/search', async (req, reply) => {
    const site = getSite();
    const isAdmin = !!req.user;
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const match = buildFtsMatch(q);

    let results: SearchHit[] = [];
    if (match) {
      try {
        const rows = db
          .prepare<{
            slug: string;
            title: string;
            published_at: string | null;
            snip: string;
          }>(
            `SELECT p.slug AS slug, p.title AS title, p.published_at AS published_at,
                    snippet(posts_fts, 3, char(1), char(2), '…', 12) AS snip
               FROM posts_fts
               JOIN posts p ON p.slug = posts_fts.slug
              WHERE posts_fts MATCH ?
                AND (p.status = 'published' OR ? = 1)
              ORDER BY bm25(posts_fts, 0.0, 10.0, 5.0, 1.0)
              LIMIT 50`
          )
          .all(match, isAdmin ? 1 : 0);
        results = rows.map((r) => ({
          slug: r.slug,
          title: r.title,
          ...(r.published_at ? { date: r.published_at.slice(0, 10) } : {}),
          snippetHtml: highlightSnippet(r.snip)
        }));
      } catch {
        // posts_fts absent (DB not migrated in this process) → degrade
        // to empty results rather than 500.
        results = [];
      }
    }

    setPublicSecurityHeaders(reply);
    if (isAdmin) reply.header('Cache-Control', 'private, no-store');
    return reply
      .type('text/html; charset=utf-8')
      .send(renderSearchPage({ site, q, results, isAdmin }));
  });

  // ---- post: GET /:slug -------------------------------------------------

  fastify.get<{ Params: { slug: string }; Querystring: { submitted?: string } }>(
    '/:slug',
    async (req, reply) => {
      const site = getSite();
      const { slug } = req.params;
      // _-prefixed slugs are system posts (e.g. _site-banner); they are
      // never indexed and must never be directly accessible via the public
      // route — return 404 unconditionally, even for authenticated users.
      if (slug.startsWith('_')) {
        setPublicSecurityHeaders(reply);
        const isAdmin = !!req.user;
        if (isAdmin) reply.header('Cache-Control', 'private, no-store');
        return reply
          .code(404)
          .type('text/html; charset=utf-8')
          .send(renderNotFoundPage({ site, isAdmin }));
      }
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
      const ctx = { siteRoot, widgets };
      const bannerHtml = await extractPostBanner(parsed.ast, ctx);
      const bodyHtml = await renderPostHtml(parsed.ast, ctx);

      const postId = getPostIdBySlug(db, parsed.frontmatter.slug);
      const comments = postId === null ? [] : listPublishedThread(db, postId);

      const html = renderPostPage({
        site,
        title: parsed.frontmatter.title,
        ...(typeof parsed.frontmatter.subtitle === 'string' && parsed.frontmatter.subtitle.trim()
          ? { subtitle: parsed.frontmatter.subtitle }
          : {}),
        slug: parsed.frontmatter.slug,
        ...(parsed.frontmatter.date ? { date: parsed.frontmatter.date } : {}),
        bodyHtml,
        ...(bannerHtml ? { bannerHtml } : {}),
        ...(site.bannerAboveHeader ? { bannerAboveHeader: true } : {}),
        isAdmin: !!req.user,
        comments,
        ...(req.query.submitted === '1' ? { commentNotice: COMMENT_SUBMITTED_NOTICE } : {})
      });

      setPublicSecurityHeaders(reply);
      if (req.user) reply.header('Cache-Control', 'private, no-store');
      return reply.type('text/html; charset=utf-8').send(html);
    }
  );
}

/** Count posts matching the given status + optional multi-tag AND filter. */
function countPosts(db: Db, status: 'published' | null, tags: string[]): number {
  if (tags.length > 0) {
    const ph = tags.map(() => '?').join(', ');
    const statusFilter = status === null ? '' : ' AND p.status = ?';
    const sql = `SELECT COUNT(*) AS n FROM posts p
       WHERE p.id IN (
         SELECT pt.post_id FROM post_tags pt
         JOIN tags tg ON tg.id = pt.tag_id
         WHERE tg.name IN (${ph}) COLLATE NOCASE
         GROUP BY pt.post_id
         HAVING COUNT(DISTINCT pt.tag_id) = ${tags.length}
       )${statusFilter}`;
    const params = status === null ? tags : [...tags, status];
    return (db.prepare<{ n: number }>(sql).get(...params) ?? { n: 0 }).n;
  }
  const sql =
    status === null
      ? 'SELECT COUNT(*) AS n FROM posts'
      : "SELECT COUNT(*) AS n FROM posts WHERE status = 'published'";
  return (db.prepare<{ n: number }>(sql).get() ?? { n: 0 }).n;
}
