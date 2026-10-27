// GET / and GET /posts: the paginated post index. When site.homePage
// names a published page, / renders that page instead and /posts stays
// the index.

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Paragraph, Root, RootContent } from 'mdast';
import type { LeafDirective } from 'mdast-util-directive';
import { readIndexedBlockPage } from '../lib/block-pages.ts';
import { extractBlockTeaser } from '../lib/block-teaser.ts';
import type { SiteConfig } from '../lib/config.ts';
import { parsePost, type RenderCtx, renderPostHtml } from '../lib/content.ts';
import type { Db } from '../lib/db.ts';
import { buildImageMap } from '../lib/image-map-fs.ts';
import { readIndexedPosts, readTagCounts } from '../lib/post-index.ts';
import { setPublicSecurityHeaders } from '../lib/security-headers.ts';
import { serverAssets } from '../lib/site-assets.ts';
import { loadChrome } from '../lib/site-chrome.ts';
import { homePageRow } from '../lib/site-org-settings.ts';
import { extractPostBanner, heroFigureIndex, renderStoredPage } from '../lib/stored-page-render.ts';
import { truncateParagraph } from '../lib/teaser-truncate.ts';
import { buildVideoMap } from '../lib/video-map-fs.ts';
import type { DirectiveNode, WidgetRegistry } from '../lib/widgets.ts';
import { type IndexTeaser, renderIndexPage } from '../templates/index.ts';

export interface IndexRoutesOpts {
  siteRoot: string;
  db: Db;
  getSite: () => SiteConfig;
  widgets: WidgetRegistry;
}

/** Exactly what a teaser renders — the hero ::figure and the lede
 * paragraph after it. The index measures the images in these nodes
 * only; measuring the whole post would open (and self-heal a bake
 * for) every image in it, and one broken image anywhere would cost
 * the index its teaser. */
function teaserNodes(ast: Root): RootContent[] {
  const heroIdx = heroFigureIndex(ast);
  if (heroIdx === -1) return [];
  const hero = ast.children[heroIdx] as RootContent;
  const lede = ast.children.slice(heroIdx + 1).find((n) => n.type === 'paragraph');
  return lede ? [hero, lede] : [hero];
}

/** First remaining top-level paragraph rendered to inline HTML (links /
 * emphasis preserved). Call AFTER extractPostBanner has spliced the hero
 * figure out, so "first paragraph" is the lede. Null when none. When
 * `maxWords > 0` the paragraph is word-truncated at the mdast layer
 * (markup-preserving) before rendering. */
async function extractFirstParagraph(
  ast: Root,
  ctx: RenderCtx,
  maxWords: number
): Promise<string | null> {
  const para = ast.children.find((n) => n.type === 'paragraph');
  if (!para) return null;
  const trimmed = truncateParagraph(para as Paragraph, maxWords);
  return renderPostHtml({ type: 'root', children: [trimmed] }, ctx);
}

/** True when an index row points at a JSON block page rather than a
 * markdown source (JSON-only pages, or posts archived after the cutover). */
function isBlocksPagePath(relPath: string): boolean {
  return path.posix.dirname(relPath) === 'content/blocks';
}

export function registerIndexRoutes(fastify: FastifyInstance, opts: IndexRoutesOpts): void {
  const { siteRoot, db, getSite, widgets } = opts;

  const indexHandler = async (
    req: FastifyRequest<{
      Querystring: { page?: string; tag?: string | string[]; sort?: string };
    }>,
    reply: FastifyReply
  ) => {
    const site = getSite();
    const isAdmin = !!req.user;
    const basePath = req.url.split('?')[0] === '/posts' ? '/posts' : '/';

    const home = basePath === '/' ? homePageRow(db, site) : null;
    if (home) {
      const html = await renderStoredPage({
        siteRoot,
        db,
        row: home,
        site,
        widgets,
        isAdmin,
        log: req.log
      });
      setPublicSecurityHeaders(reply);
      if (isAdmin) reply.header('Cache-Control', 'private, no-store');
      return reply.type('text/html; charset=utf-8').send(html);
    }

    // Only one tag at a time (OR/replace logic). Fastify may deliver a
    // string or string[] for repeated params; take the first non-empty value.
    const rawTag = req.query.tag;
    const firstTag = (Array.isArray(rawTag) ? rawTag[0] : rawTag)?.trim();
    const activeTags = firstTag ? [firstTag] : [];
    const sort: 'asc' | 'desc' = req.query.sort === 'asc' ? 'asc' : 'desc';
    // Authed visitors see drafts + published (the index doubles as
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
        const { ast } = parsePost(await fs.promises.readFile(siteBannerPath, 'utf8'));
        const figureNode = ast.children.find(
          (n): n is LeafDirective =>
            n.type === 'leafDirective' && (n as LeafDirective).name === 'figure'
        ) as LeafDirective | undefined;
        if (figureNode) {
          siteBannerFigureFound = true;
          const dir = figureNode as DirectiveNode;
          indexBannerHtml = await widgets.dispatch('figure', dir, {
            images: await buildImageMap(siteRoot, dir, { log: req.log }),
            videos: new Map(),
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
      indexBannerHtml = await widgets.dispatch('figure', bannerNode, {
        images: await buildImageMap(siteRoot, bannerNode, { log: req.log }),
        videos: new Map(),
        widgets
      });
    }

    // Teaser: anonymous view only, behind the postTeaser toggle.
    // Read the current top post and drop it from the list so it is not
    // duplicated. Archived/JSON-only rows render the hero figure and
    // lede from their block tree; unarchived rows keep reading the
    // markdown source (path already includes content/posts/, so join
    // directly onto siteRoot — same as the GET /:slug handler).
    let teaser: IndexTeaser | undefined;
    let listRows = rows;
    const top = rows[0];
    if (!isAdmin && site.postTeaser && top) {
      try {
        let parts: { bannerHtml: string; excerptHtml: string } | null = null;
        if (isBlocksPagePath(top.path)) {
          const twin = readIndexedBlockPage(siteRoot, top);
          if (twin) {
            parts = await extractBlockTeaser(
              siteRoot,
              twin.tree,
              widgets,
              site.teaserWords ?? 0,
              req.log
            );
          }
        } else {
          const rawTop = await fs.promises.readFile(path.join(siteRoot, top.path), 'utf8');
          const { ast } = parsePost(rawTop);
          const ctx = {
            images: await buildImageMap(siteRoot, teaserNodes(ast), { log: req.log }),
            videos: await buildVideoMap(siteRoot),
            widgets
          };
          const bannerHtml = await extractPostBanner(ast, ctx);
          const excerptHtml = bannerHtml
            ? await extractFirstParagraph(ast, ctx, site.teaserWords ?? 0)
            : null;
          if (bannerHtml && excerptHtml) parts = { bannerHtml, excerptHtml };
        }
        if (parts) {
          teaser = {
            slug: top.slug,
            title: top.title,
            ...(top.published_at ? { date: top.published_at } : {}),
            ...parts
          };
          listRows = rows.slice(1);
        }
      } catch {
        // Unreadable / malformed top post → no teaser, full list.
      }
    }

    const html = renderIndexPage({
      site,
      assets: serverAssets(),
      chrome: await loadChrome(siteRoot, site, req.log),
      page: 1,
      totalPages: 1,
      basePath,
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
    // intermediary skip caching — a post-action 303 redirect to
    // /posts would otherwise serve the previously-cached pre-action body.
    if (isAdmin) reply.header('Cache-Control', 'private, no-store');
    return reply.type('text/html; charset=utf-8').send(html);
  };
  fastify.get('/', indexHandler);
  fastify.get('/posts', indexHandler);
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
       ) AND p.kind = 'post'${statusFilter}`;
    const params = status === null ? tags : [...tags, status];
    return (db.prepare<{ n: number }>(sql).get(...params) ?? { n: 0 }).n;
  }
  const sql =
    status === null
      ? "SELECT COUNT(*) AS n FROM posts WHERE kind = 'post'"
      : "SELECT COUNT(*) AS n FROM posts WHERE kind = 'post' AND status = 'published'";
  return (db.prepare<{ n: number }>(sql).get() ?? { n: 0 }).n;
}
