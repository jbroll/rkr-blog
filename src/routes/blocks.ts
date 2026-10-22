// Experimental JSON-blocks routes:
//   GET /blocks/:macro              — public render of one macro (no overrides)
//   GET /admin/blocks/preview/:macro — same render for signed-in editors
//
// Unknown macros and bad names 404; in-page macro problems still render
// as HTML comments via the renderer. Image maps are built from the
// figure leaves' ids through the same prepass the post page uses.

import type { FastifyInstance } from 'fastify';

import { requireUser } from '../lib/auth-middleware.ts';
import type { SiteConfig } from '../lib/config.ts';
import { buildImageMap } from '../lib/image-map-fs.ts';
import { buildVideoMap } from '../lib/video-map-fs.ts';
import { setPublicSecurityHeaders } from '../lib/security-headers.ts';
import { serverAssets } from '../lib/site-assets.ts';
import { expandMacro, loadMacroLibrary } from '../lib/macro-library.ts';
import { renderBlockTree } from '../lib/blocks-render.ts';
import type { BlockNode } from '../lib/blocks.ts';
import { type DirectiveNode, WidgetRegistry } from '../lib/widgets.ts';
import { renderBlocksPage } from '../templates/blocks.ts';
import figureWidget from '../widgets/figure.ts';
import videoWidget from '../widgets/video.ts';

const VALID_MACRO = /^[a-z][a-z0-9-]*$/;

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

export function registerBlockRoutes(fastify: FastifyInstance, opts: BlockRoutesOpts): void {
  const { siteRoot, getSite } = opts;
  const widgets = new WidgetRegistry();
  widgets.register(figureWidget);
  widgets.register(videoWidget);
  const guard = opts.requireAuth ? { preHandler: requireUser } : {};

  async function renderMacro(name: string, log: { warn(o: object, m: string): void }) {
    const lib = loadMacroLibrary(`${siteRoot}/macros`);
    const def = lib.get(name);
    if (!def) return null;
    const tree = expandMacro(lib, name, {});
    const figures = figureLeaves({ type: 'col', children: [tree] });
    const synthetic = figures.map((f) => ({
      type: 'leafDirective',
      name: 'figure',
      attributes: { ids: String((f.slots?.ids ?? '') as string) },
      children: [],
    }));
    const ctx = {
      images: await buildImageMap(siteRoot, synthetic as unknown as DirectiveNode[], { log }),
      videos: await buildVideoMap(siteRoot),
      widgets,
    };
    return renderBlockTree({ version: 1, body: [tree] }, ctx, {
      get: (n: string) => {
        const d = lib.get(n);
        return d ? { defaults: d.defaults, tree: d.tree } : undefined;
      },
    });
  }

  fastify.get<{ Params: { macro: string } }>('/blocks/:macro', async (req, reply) => {
    const site = getSite();
    const { macro } = req.params;
    if (!VALID_MACRO.test(macro)) {
      return reply.code(404).type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Not found</title></head><body><main><h1>Page not found</h1></main></body></html>`);
    }
    const bodyHtml = await renderMacro(macro, req.log);
    if (bodyHtml === null) {
      return reply.code(404).type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Not found</title></head><body><main><h1>Page not found</h1></main></body></html>`);
    }
    setPublicSecurityHeaders(reply);
    return reply.type('text/html; charset=utf-8').send(
      renderBlocksPage({
        site,
        assets: serverAssets(),
        title: macro,
        bodyHtml,
        isAdmin: !!req.user,
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
      if (bodyHtml === null) return reply.code(404).type('text/html; charset=utf-8').send('not found');
      setPublicSecurityHeaders(reply);
      return reply.type('text/html; charset=utf-8').send(
        renderBlocksPage({
          site,
          assets: serverAssets(),
          title: `Preview: ${macro}`,
          bodyHtml,
          isAdmin: true,
        })
      );
    }
  );
}
