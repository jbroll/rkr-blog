// Experimental JSON-blocks routes:
//   GET /blocks/:macro              — public render of one macro (no overrides)
//   GET /pages/:slug                — public render of one stored JSON page
//   GET /admin/blocks/preview/:macro — macro preview for signed-in editors
//
// Unknown names and bad slugs 404; in-page macro problems still render
// as HTML comments via the renderer. Image maps are built from the
// figure leaves' ids through the same prepass the post page uses.

import type { FastifyInstance, FastifyReply } from 'fastify';

import { requireUser } from '../lib/auth-middleware.ts';
import { listBlockPages, readBlockPage } from '../lib/block-pages.ts';
import type { BlockNode, BlockTree } from '../lib/blocks.ts';
import { renderBlockTree } from '../lib/blocks-render.ts';
import type { SiteConfig } from '../lib/config.ts';
import { buildImageMap } from '../lib/image-map-fs.ts';
import { expandMacro, loadMacroLibrary } from '../lib/macro-library.ts';
import { setPublicSecurityHeaders } from '../lib/security-headers.ts';
import { serverAssets } from '../lib/site-assets.ts';
import { buildVideoMap } from '../lib/video-map-fs.ts';
import { type DirectiveNode, WidgetRegistry } from '../lib/widgets.ts';
import { renderBlocksIndex, renderBlocksPage } from '../templates/blocks.ts';
import figureWidget from '../widgets/figure.ts';
import videoWidget from '../widgets/video.ts';

const VALID_MACRO = /^[a-z][a-z0-9-]*$/;
const VALID_SLUG = /^[a-z0-9-]+$/;

export interface BlockRoutesOpts {
  siteRoot: string;
  getSite: () => SiteConfig;
  /** When true, the preview route requires a signed-in admin. */
  requireAuth: boolean;
}

function figureLeaves(node: BlockNode, out: BlockNode[] = []): BlockNode[] {
  if (node.type === 'figure') out.push(node);
  if (node.type === 'macro') return out;
  const kids =
    (node as { children?: BlockNode[] }).children ??
    (node as { blocks?: BlockNode[] }).blocks ??
    [];
  for (const k of kids) figureLeaves(k, out);
  return out;
}

function sendPages404(reply: FastifyReply) {
  return reply
    .code(404)
    .type('text/html; charset=utf-8')
    .send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Not found</title></head><body><main><h1>Page not found</h1></main></body></html>`);
}

export function registerBlockRoutes(fastify: FastifyInstance, opts: BlockRoutesOpts): void {
  const { siteRoot, getSite } = opts;
  const widgets = new WidgetRegistry();
  widgets.register(figureWidget);
  widgets.register(videoWidget);
  const guard = opts.requireAuth ? { preHandler: requireUser } : {};

  async function renderTree(
    tree: BlockTree,
    lib: { get(n: string): { defaults: Record<string, unknown>; tree: BlockNode } | undefined },
    log: { warn(o: object, m: string): void }
  ) {
    const figures = figureLeaves({ type: 'col', children: tree.body });
    const synthetic = figures.map((f) => ({
      type: 'leafDirective',
      name: 'figure',
      attributes: { ids: String((f.slots?.ids ?? '') as string) },
      children: []
    }));
    const ctx = {
      images: await buildImageMap(siteRoot, synthetic as unknown as DirectiveNode[], { log }),
      videos: await buildVideoMap(siteRoot),
      widgets
    };
    return renderBlockTree(tree, ctx, lib);
  }

  function libView() {
    const lib = loadMacroLibrary(`${siteRoot}/macros`);
    return {
      lib,
      view: {
        get: (n: string) => {
          const d = lib.get(n);
          return d ? { defaults: d.defaults, tree: d.tree } : undefined;
        }
      }
    };
  }

  async function renderMacro(name: string, log: { warn(o: object, m: string): void }) {
    const { lib, view } = libView();
    const def = lib.get(name);
    if (!def) return null;
    const tree = expandMacro(lib, name, {});
    return renderTree({ version: 1, body: [tree] }, view, log);
  }

  async function renderPage(slug: string, log: { warn(o: object, m: string): void }) {
    const page = readBlockPage(siteRoot, slug);
    if (!page) return null;
    const { view } = libView();
    const bodyHtml = await renderTree(page.tree, view, log);
    return { title: page.title, bodyHtml };
  }

  fastify.get<{ Params: { macro: string } }>('/blocks/:macro', async (req, reply) => {
    const site = getSite();
    const { macro } = req.params;
    if (!VALID_MACRO.test(macro)) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Not found</title></head><body><main><h1>Page not found</h1></main></body></html>`);
    }
    const bodyHtml = await renderMacro(macro, req.log);
    if (bodyHtml === null) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Not found</title></head><body><main><h1>Page not found</h1></main></body></html>`);
    }
    setPublicSecurityHeaders(reply);
    return reply.type('text/html; charset=utf-8').send(
      renderBlocksPage({
        site,
        assets: serverAssets(),
        title: macro,
        bodyHtml,
        isAdmin: !!req.user
      })
    );
  });

  fastify.get('/pages', async (req, reply) => {
    const site = getSite();
    const pages = listBlockPages(siteRoot);
    setPublicSecurityHeaders(reply);
    return reply.type('text/html; charset=utf-8').send(
      renderBlocksPage({
        site,
        assets: serverAssets(),
        title: 'Pages',
        bodyHtml: `<h1>Pages</h1>\n${renderBlocksIndex(pages)}`,
        isAdmin: !!req.user
      })
    );
  });

  fastify.get<{ Params: { slug: string } }>('/pages/:slug', async (req, reply) => {
    const site = getSite();
    const { slug } = req.params;
    if (!VALID_SLUG.test(slug)) return sendPages404(reply);
    const rendered = await renderPage(slug, req.log);
    if (rendered === null) return sendPages404(reply);
    setPublicSecurityHeaders(reply);
    return reply.type('text/html; charset=utf-8').send(
      renderBlocksPage({
        site,
        assets: serverAssets(),
        title: rendered.title,
        slug,
        bodyHtml: rendered.bodyHtml,
        isAdmin: !!req.user
      })
    );
  });

  fastify.get<{ Params: { macro: string } }>(
    '/admin/blocks/preview/:macro',
    { ...guard },
    async (req, reply) => {
      const site = getSite();
      const { macro } = req.params;
      if (!VALID_MACRO.test(macro)) {
        return reply.code(404).type('text/html; charset=utf-8').send('not found');
      }
      const bodyHtml = await renderMacro(macro, req.log);
      if (bodyHtml === null)
        return reply.code(404).type('text/html; charset=utf-8').send('not found');
      setPublicSecurityHeaders(reply);
      return reply.type('text/html; charset=utf-8').send(
        renderBlocksPage({
          site,
          assets: serverAssets(),
          title: `Preview: ${macro}`,
          bodyHtml,
          isAdmin: true
        })
      );
    }
  );
}
