// Experimental JSON-blocks editor save:
//   POST /admin/blocks/:slug { tree } — validate and store one page.
//
// The URL slug wins: it names the file and overwrites fields.slug, so a
// rename is a save under a new slug plus a delete of the old file (the
// delete half is still manual). Invalid trees are 400, never stored.

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

import { requireUser } from '../lib/auth-middleware.ts';
import { listBlockPages, readBlockPage } from '../lib/block-pages.ts';
import { type BlockNode, type BlockTree, parseBlockTree } from '../lib/blocks.ts';
import { renderBlockTree } from '../lib/blocks-render.ts';
import type { SiteConfig } from '../lib/config.ts';
import type { Db } from '../lib/db.ts';
import { buildImageMap } from '../lib/image-map-fs.ts';
import { loadMacroLibrary } from '../lib/macro-library.ts';
import { runReindex } from '../lib/post-index.ts';
import { setPublicSecurityHeaders } from '../lib/security-headers.ts';
import { serverAssets } from '../lib/site-assets.ts';
import { buildVideoMap } from '../lib/video-map-fs.ts';
import { type DirectiveNode, WidgetRegistry } from '../lib/widgets.ts';
import { renderBlocksEditPage } from '../templates/admin-blocks-edit.ts';
import { renderBlocksNewPage } from '../templates/admin-blocks-new.ts';
import { renderBlocksIndex, renderBlocksPage } from '../templates/blocks.ts';
import figureWidget from '../widgets/figure.ts';
import videoWidget from '../widgets/video.ts';
import { prewarmBlockTree } from './admin-prewarm.ts';

const VALID_SLUG = /^[a-z0-9-]+$/;

/** Invisible marker prepended to each rendered node on the edit page.
 * Form is pinned (`<!--rkr:path=i,j-->`, no spaces) so the client can
 * parse it with a single regex. */
const pathMarker = (path: number[]): string => `<!--rkr:path=${path.join(',')}-->`;

/** Figure directives eligible for the image-map prepass. Mirrors the
 * `/pages/:slug` render (see routes/blocks.ts): macro internals are not
 * walked here. */
function figureDirectives(tree: BlockTree): DirectiveNode[] {
  const out: DirectiveNode[] = [];
  const walk = (node: BlockNode): void => {
    if (node.type === 'figure') {
      out.push({
        type: 'leafDirective',
        name: 'figure',
        attributes: { ids: String((node.slots?.ids ?? '') as string) },
        children: []
      });
      return;
    }
    if (node.type === 'macro') return;
    const kids: BlockNode[] =
      (node as { children?: BlockNode[] }).children ??
      (node as { blocks?: BlockNode[] }).blocks ??
      [];
    for (const k of kids) walk(k);
  };
  for (const n of tree.body) walk(n);
  return out;
}

export interface AdminBlockRoutesOpts {
  siteRoot: string;
  getSite: () => SiteConfig;
  /** When true, saving requires a signed-in admin. */
  requireAuth: boolean;
  /** Job queue connection for pre-warming block media. Optional so
   * read-only editor mounts (no DB) still work. */
  db?: Db;
}

export function registerAdminBlockRoutes(
  fastify: FastifyInstance,
  opts: AdminBlockRoutesOpts
): void {
  const { siteRoot, getSite } = opts;
  const guard = opts.requireAuth ? { preHandler: requireUser } : {};
  const widgets = new WidgetRegistry();
  widgets.register(figureWidget);
  widgets.register(videoWidget);

  fastify.get('/admin/blocks/macros', { ...guard }, async (_req, _reply) => {
    const lib = loadMacroLibrary(`${siteRoot}/macros`);
    return [...lib.keys()].sort().map((name) => ({
      name,
      label: name
        .split('-')
        .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
        .join(' ')
    }));
  });

  fastify.get<{ Params: { slug: string } }>(
    '/admin/blocks/:slug',
    { ...guard },
    async (req, reply) => {
      const { slug } = req.params;
      const page = readBlockPage(siteRoot, slug);
      if (!page) return reply.code(404).send({ error: 'not found' });
      return { slug, title: page.title, tree: page.tree };
    }
  );

  fastify.get('/admin/blocks', { ...guard }, async (_req, reply) => {
    setPublicSecurityHeaders(reply);
    const assets = serverAssets('/admin/static');
    return reply.type('text/html; charset=utf-8').send(
      renderBlocksPage({
        site: getSite(),
        assets,
        title: 'Blocks',
        bodyHtml: `<h1>Blocks</h1>\n${renderBlocksIndex(listBlockPages(siteRoot), { newPageUrl: '/admin/blocks/new', editBase: '/admin/blocks/edit' })}`,
        isAdmin: true
      })
    );
  });

  fastify.get('/admin/blocks/new', { ...guard }, async (_req, reply) => {
    setPublicSecurityHeaders(reply);
    const assets = serverAssets('/admin/static');
    return reply
      .type('text/html; charset=utf-8')
      .send(renderBlocksNewPage({ site: getSite(), assets, isAdmin: true }));
  });

  fastify.post<{ Body: { slug?: string } }>(
    '/admin/blocks/new',
    { ...guard },
    async (req, reply) => {
      const slug = typeof req.body?.slug === 'string' ? req.body.slug.trim() : '';
      if (!/^[a-z0-9-]+$/.test(slug)) return reply.code(404).send({ error: 'not found' });
      const dest = path.join(siteRoot, 'content', 'blocks', `${slug}.json`);
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(
          dest,
          `${JSON.stringify({ version: 1, body: [], fields: { title: slug, slug, status: 'draft' } }, null, 2)}\n`
        );
      }
      return reply.code(303).header('location', `/admin/blocks/edit/${slug}`).send();
    }
  );

  fastify.get<{ Params: { slug: string } }>(
    '/admin/blocks/edit/:slug',
    { ...guard },
    async (req, reply) => {
      const { slug } = req.params;
      const page = VALID_SLUG.test(slug) ? readBlockPage(siteRoot, slug) : null;
      if (!page) return reply.code(404).send({ error: 'not found' });

      // Render the same body the public page shows (/pages/:slug
      // pipeline: macro library, image/video maps, widget dispatch),
      // plus invisible path markers for in-place editing, and embed the
      // canonical tree for client hydration.
      const lib = loadMacroLibrary(path.join(siteRoot, 'macros'));
      const macroLib = {
        get: (name: string) => {
          const def = lib.get(name);
          return def ? { defaults: def.defaults, tree: def.tree } : undefined;
        }
      };
      const ctx = {
        images: await buildImageMap(siteRoot, figureDirectives(page.tree), { log: req.log }),
        videos: await buildVideoMap(siteRoot),
        widgets
      };
      const bodyHtml = await renderBlockTree(page.tree, ctx, macroLib, { mark: pathMarker });

      setPublicSecurityHeaders(reply);
      const assets = serverAssets('/admin/static');
      return reply.type('text/html; charset=utf-8').send(
        renderBlocksEditPage({
          site: getSite(),
          assets,
          slug,
          bundleUrl: `/admin/static/admin/blocks-page-editor-entry.js?v=${assets.hash}`,
          isAdmin: true,
          bodyHtml,
          treeJson: JSON.stringify(page.tree)
        })
      );
    }
  );

  fastify.post<{ Params: { slug: string }; Body: unknown }>(
    '/admin/blocks/:slug',
    { ...guard },
    async (req, reply) => {
      const { slug } = req.params;
      if (!VALID_SLUG.test(slug)) return reply.code(404).send({ error: 'not found' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      let tree: BlockTree & { fields: Record<string, unknown> };
      try {
        if (!body || typeof body !== 'object' || !('tree' in body)) throw new Error('missing tree');
        const raw = (body as { tree: unknown }).tree;
        if (!raw || typeof raw !== 'object') throw new Error('missing tree');
        const rec = raw as { version?: unknown; body?: unknown; fields?: unknown };
        tree = {
          ...parseBlockTree({ version: 1, body: rec.body }),
          fields: {
            ...((rec.fields ?? {}) as Record<string, unknown>),
            slug
          }
        };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const dest = path.join(siteRoot, 'content', 'blocks', `${slug}.json`);
      const inserted = !fs.existsSync(dest);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, `${JSON.stringify(tree, null, 2)}\n`);

      // Public / and /:slug read the DB index, not the JSON files, so a
      // save must reindex before the page is reachable (mirrors the
      // retired markdown save handler). wp-push also reindexes after
      // its POST; runReindex is idempotent, so the extra call is
      // harmless.
      runReindex(siteRoot);

      // Warm the derivative queue for any media the saved tree
      // references. Best-effort: a pre-warm failure must not fail the
      // save itself.
      if (opts.db) {
        try {
          await prewarmBlockTree(opts.db, siteRoot, tree);
        } catch (err) {
          req.log.warn({ err, slug }, 'pre-warm enqueue failed');
        }
      }

      return { slug, inserted };
    }
  );
}
