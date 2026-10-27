// A stored page (JSON twin or markdown file) rendered to a full HTML
// document. Shared by GET /, GET /:slug and GET /about.

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Root, RootContent } from 'mdast';
import { COMMENT_SUBMITTED_NOTICE } from '../templates/comments.ts';
import { renderPostPage } from '../templates/post.ts';
import { readIndexedBlockPage } from './block-pages.ts';
import { renderBlockPost } from './block-post-render.ts';
import { getPostIdBySlug, listPublishedThread } from './comments.ts';
import type { SiteConfig } from './config.ts';
import { parsePost, type RenderCtx, renderPostHtml } from './content.ts';
import type { Db } from './db.ts';
import { buildImageMap } from './image-map-fs.ts';
import type { IndexedPost } from './post-index.ts';
import { serverAssets } from './site-assets.ts';
import { buildVideoMap } from './video-map-fs.ts';
import type { DirectiveNode, WidgetRegistry } from './widgets.ts';

/** Index of the post's hero figure: the first non-yaml node, when that
 * node is a ::figure leafDirective. -1 when it is anything else. */
export function heroFigureIndex(ast: Root): number {
  for (let i = 0; i < ast.children.length; i++) {
    const node = ast.children[i] as RootContent;
    if (node.type === 'yaml') continue;
    const dir = node as unknown as DirectiveNode;
    return node.type === 'leafDirective' && dir.name === 'figure' ? i : -1;
  }
  return -1;
}

/** Splice the hero ::figure out of the AST and return its rendered
 * HTML. The directive's own attributes (justify, aspect, etc.) are
 * preserved verbatim so the author controls the banner appearance by
 * editing the markdown. Returns null when the post has no hero. */
export async function extractPostBanner(ast: Root, ctx: RenderCtx): Promise<string | null> {
  const heroIdx = heroFigureIndex(ast);
  if (heroIdx === -1) return null;
  const dir = ast.children[heroIdx] as unknown as DirectiveNode;
  const html = await ctx.widgets.dispatch('figure', dir, ctx);
  ast.children.splice(heroIdx, 1);
  return html;
}

export interface StoredPageOpts {
  siteRoot: string;
  db: Db;
  row: IndexedPost;
  site: SiteConfig;
  widgets: WidgetRegistry;
  isAdmin: boolean;
  log: FastifyBaseLogger;
  submitted?: boolean;
}

export async function renderStoredPage(opts: StoredPageOpts): Promise<string> {
  const { siteRoot, db, row, site, widgets, isAdmin, log } = opts;
  // A stored twin renders the page body; the markdown file (when paired)
  // supplies nothing at render time. The index already carries its title,
  // date, status, and tags.
  const twin = readIndexedBlockPage(siteRoot, row);
  const videos = await buildVideoMap(siteRoot);
  let title: string;
  let date: string | undefined;
  let subtitle: string | undefined;
  let bannerHtml: string | null = null;
  let bodyHtml: string;
  if (twin) {
    const parts = await renderBlockPost(siteRoot, twin, { widgets, videos, log });
    bodyHtml = parts.bodyHtml;
    bannerHtml = parts.bannerHtml;
    subtitle = parts.subtitle;
    title = twin.title;
    date = row.published_at ?? undefined;
  } else {
    const raw = await fs.promises.readFile(path.join(siteRoot, row.path), 'utf8');
    const parsed = parsePost(raw);
    const ctx = {
      images: await buildImageMap(siteRoot, parsed.ast, { log }),
      videos,
      widgets
    };
    bannerHtml = await extractPostBanner(parsed.ast, ctx);
    bodyHtml = await renderPostHtml(parsed.ast, ctx);
    title = parsed.frontmatter.title;
    date = parsed.frontmatter.date;
    if (typeof parsed.frontmatter.subtitle === 'string' && parsed.frontmatter.subtitle.trim()) {
      subtitle = parsed.frontmatter.subtitle;
    }
  }

  const isPage = row.kind === 'page';
  const postId = isPage ? null : getPostIdBySlug(db, row.slug);
  const comments = postId === null ? [] : listPublishedThread(db, postId);

  return renderPostPage({
    site,
    assets: serverAssets(),
    title,
    ...(subtitle ? { subtitle } : {}),
    slug: row.slug,
    ...(date ? { date } : {}),
    bodyHtml,
    ...(bannerHtml ? { bannerHtml } : {}),
    ...(site.bannerAboveHeader ? { bannerAboveHeader: true } : {}),
    isAdmin,
    comments,
    ...(isPage ? { showHeader: false, showComments: false } : {}),
    ...(opts.submitted ? { commentNotice: COMMENT_SUBMITTED_NOTICE } : {})
  });
}
