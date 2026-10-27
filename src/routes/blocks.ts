// JSON-blocks routes outside the editor:
//   GET /pages/:slug                 — 301 to /:slug for a published page, else 404
//   GET /admin/blocks/preview/:macro — macro preview for signed-in editors
//
// Pages render publicly only through GET /:slug, which reads the index
// and hides drafts; this file never renders a stored page.

import type { FastifyInstance, FastifyReply } from 'fastify';

import { requireUser } from '../lib/auth-middleware.ts';
import { readBlockPage } from '../lib/block-pages.ts';
import { collectBlockFigureIds, renderBlockTree } from '../lib/blocks-render.ts';
import type { SiteConfig } from '../lib/config.ts';
import { buildImageMap } from '../lib/image-map-fs.ts';
import { expandMacro, loadMacroLibrary } from '../lib/macro-library.ts';
import { setPublicSecurityHeaders } from '../lib/security-headers.ts';
import { serverAssets } from '../lib/site-assets.ts';
import { loadChrome } from '../lib/site-chrome.ts';
import { buildVideoMap } from '../lib/video-map-fs.ts';
import { type DirectiveNode, WidgetRegistry } from '../lib/widgets.ts';
import { renderBlocksPage } from '../templates/blocks.ts';
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

  async function renderMacro(name: string, log: { warn(o: object, m: string): void }) {
    const lib = loadMacroLibrary(`${siteRoot}/macros`, log);
    if (!lib.get(name)) return null;
    const tree = { version: 1 as const, body: [expandMacro(lib, name, {})] };
    const macroLib = {
      get: (n: string) => {
        const d = lib.get(n);
        return d ? { defaults: d.defaults, tree: d.tree } : undefined;
      }
    };
    const synthetic = collectBlockFigureIds(tree, macroLib).map((ids) => ({
      type: 'leafDirective',
      name: 'figure',
      attributes: { ids },
      children: []
    }));
    const ctx = {
      images: await buildImageMap(siteRoot, synthetic as unknown as DirectiveNode[], { log }),
      videos: await buildVideoMap(siteRoot),
      widgets
    };
    return renderBlockTree(tree, ctx, macroLib);
  }

  // Old /pages/:slug links land on the canonical URL. A draft 404s so the
  // redirect never confirms that an unpublished slug exists.
  fastify.get<{ Params: { slug: string } }>('/pages/:slug', async (req, reply) => {
    const { slug } = req.params;
    if (!VALID_SLUG.test(slug)) return sendPages404(reply);
    const page = readBlockPage(siteRoot, slug);
    if (page?.fields.status !== 'published') return sendPages404(reply);
    setPublicSecurityHeaders(reply);
    return reply.redirect(`/${slug}`, 301);
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
          chrome: await loadChrome(siteRoot, site, req.log),
          title: `Preview: ${macro}`,
          bodyHtml,
          isAdmin: true
        })
      );
    }
  );
}
