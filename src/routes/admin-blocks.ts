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
import { readBlockPage } from '../lib/block-pages.ts';
import { parseBlockTree } from '../lib/blocks.ts';
import type { SiteConfig } from '../lib/config.ts';
import { loadMacroLibrary } from '../lib/macro-library.ts';
import { setPublicSecurityHeaders } from '../lib/security-headers.ts';
import { serverAssets } from '../lib/site-assets.ts';
import { renderBlocksEditPage } from '../templates/admin-blocks-edit.ts';

const VALID_SLUG = /^[a-z0-9-]+$/;

export interface AdminBlockRoutesOpts {
  siteRoot: string;
  getSite: () => SiteConfig;
  /** When true, saving requires a signed-in admin. */
  requireAuth: boolean;
}

export function registerAdminBlockRoutes(
  fastify: FastifyInstance,
  opts: AdminBlockRoutesOpts
): void {
  const { siteRoot, getSite } = opts;
  const guard = opts.requireAuth ? { preHandler: requireUser } : {};

  fastify.get('/admin/blocks/macros', { ...guard }, async (_req, _reply) => {
    const lib = loadMacroLibrary(`${siteRoot}/macros`);
    return [...lib.keys()].sort().map((name) => ({
      name,
      label: name
        .split('-')
        .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
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

  fastify.get<{ Params: { slug: string } }>(
    '/admin/blocks/edit/:slug',
    { ...guard },
    async (req, reply) => {
      const { slug } = req.params;
      if (!/^[a-z0-9-]+$/.test(slug) || !readBlockPage(siteRoot, slug)) {
        return reply.code(404).send({ error: 'not found' });
      }
      setPublicSecurityHeaders(reply);
      const assets = serverAssets('/admin/static');
      return reply.type('text/html; charset=utf-8').send(
        renderBlocksEditPage({
          site: getSite(),
          assets,
          slug,
          bundleUrl: `/admin/static/admin/blocks-page-editor-entry.js?v=${assets.hash}`,
          isAdmin: true
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
      let tree;
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
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, `${JSON.stringify(tree, null, 2)}\n`);
      return { slug };
    }
  );
}
