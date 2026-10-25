// Experimental JSON-blocks editor save:
//   POST /admin/blocks/:slug { tree } — validate and store one page.
//
// The URL slug wins: it names the file and overwrites fields.slug, so a
// rename is a save under a new slug plus a delete of the old file (the
// delete half is still manual). Invalid trees are 400, never stored.

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { requireUser } from '../lib/auth-middleware.ts';
import { findBlockFile, listBlockPages, readBlockPage } from '../lib/block-pages.ts';
import { type BlockTree, parseBlockTree } from '../lib/blocks.ts';
import { renderEditBody } from '../lib/blocks-edit-render.ts';
import type { SiteConfig } from '../lib/config.ts';
import type { Db } from '../lib/db.ts';
import { loadMacroLibrary, ROOT_MACROS } from '../lib/macro-library.ts';
import { runReindex } from '../lib/post-index.ts';
import {
  setAdminEditorSecurityHeaders,
  setPublicSecurityHeaders
} from '../lib/security-headers.ts';
import { serverAssets } from '../lib/site-assets.ts';
import { renderBlocksEditPage } from '../templates/admin-blocks-edit.ts';
import { renderBlocksNewPage } from '../templates/admin-blocks-new.ts';
import { renderBlocksIndex, renderBlocksPage } from '../templates/blocks.ts';
import { prewarmBlockTree } from './admin-prewarm.ts';

const VALID_SLUG = /^[a-z0-9-]+$/;

const blockFile = (siteRoot: string, slug: string): string =>
  path.join(siteRoot, 'content', 'blocks', `${slug}.json`);

/** Fields of the page stored in `file`; {} when absent or unreadable. */
function readStoredFields(file: string | null): Record<string, unknown> {
  if (!file) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { fields?: unknown };
    const f = parsed?.fields;
    return f && typeof f === 'object' && !Array.isArray(f) ? (f as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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

  fastify.get('/admin/blocks/macros', { ...guard }, async (_req, _reply) => {
    const lib = loadMacroLibrary(`${siteRoot}/macros`);
    return [...lib.keys()]
      .filter((name) => !ROOT_MACROS.has(name))
      .sort()
      .map((name) => {
        const macro = lib.get(name);
        return {
          name,
          label: name
            .split('-')
            .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
            .join(' '),
          group: 'Sections',
          description: macro?.description ?? 'Ready-made section',
          defaults: macro?.defaults ?? {},
          fieldSchema: macro?.fieldSchema ?? {}
        };
      });
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

  const sendNewForm = (
    reply: FastifyReply,
    status: number,
    form: { title?: string; slug?: string; error?: string }
  ) => {
    setPublicSecurityHeaders(reply);
    return reply
      .code(status)
      .type('text/html; charset=utf-8')
      .send(
        renderBlocksNewPage({
          site: getSite(),
          assets: serverAssets('/admin/static'),
          isAdmin: true,
          ...form
        })
      );
  };

  fastify.get('/admin/blocks/new', { ...guard }, async (_req, reply) =>
    sendNewForm(reply, 200, {})
  );

  fastify.post<{ Body: { title?: string; slug?: string } }>(
    '/admin/blocks/new',
    { ...guard },
    async (req, reply) => {
      const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
      const slug = str(req.body?.slug);
      const title = str(req.body?.title) || slug;
      if (!VALID_SLUG.test(slug)) {
        return sendNewForm(reply, 400, {
          title,
          slug,
          error: 'Use lowercase letters, digits and hyphens.'
        });
      }
      if (fs.existsSync(blockFile(siteRoot, slug)) || readBlockPage(siteRoot, slug)) {
        return sendNewForm(reply, 409, {
          title,
          slug,
          error: `A page with the slug "${slug}" already exists. Choose another.`
        });
      }
      const dest = blockFile(siteRoot, slug);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(
        dest,
        `${JSON.stringify({ version: 1, body: [], fields: { title, slug, status: 'draft' } }, null, 2)}\n`
      );
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

      const bodyHtml = await renderEditBody(siteRoot, page.tree, req.log);

      setAdminEditorSecurityHeaders(reply);
      const assets = serverAssets('/admin/static');
      return reply.type('text/html; charset=utf-8').send(
        renderBlocksEditPage({
          site: getSite(),
          assets,
          slug,
          bundleUrl: `/admin/static/admin/blocks-page-editor-entry.js?v=${assets.hash}`,
          isAdmin: true,
          title: page.title,
          bodyHtml,
          treeJson: JSON.stringify({ ...page.tree, fields: page.fields })
        })
      );
    }
  );

  // Re-render for the editor after a structural change. Never writes;
  // the save route persists. The `_` keeps it off VALID_SLUG, so no
  // page slug can collide with it.
  fastify.post<{ Body: unknown }>('/admin/blocks/_render', { ...guard }, async (req, reply) => {
    let tree: BlockTree;
    try {
      tree = parseBlockTree((req.body as { tree?: unknown } | null)?.tree);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return { html: await renderEditBody(siteRoot, tree, req.log) };
  });

  fastify.post<{ Params: { slug: string }; Body: unknown }>(
    '/admin/blocks/:slug',
    { ...guard },
    async (req, reply) => {
      const { slug } = req.params;
      if (!VALID_SLUG.test(slug)) return reply.code(404).send({ error: 'not found' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      let existing: string | null = null;
      let tree: BlockTree & { fields: Record<string, unknown> };
      try {
        if (!body || typeof body !== 'object' || !('tree' in body)) throw new Error('missing tree');
        const raw = (body as { tree: unknown }).tree;
        if (!raw || typeof raw !== 'object') throw new Error('missing tree');
        const rec = raw as { version?: unknown; body?: unknown; fields?: unknown };
        existing = findBlockFile(siteRoot, slug);
        const existingFields = readStoredFields(existing);
        tree = {
          ...parseBlockTree({ version: 1, body: rec.body }),
          fields: {
            ...existingFields,
            ...((rec.fields ?? {}) as Record<string, unknown>),
            slug
          }
        };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const dest = existing ?? blockFile(siteRoot, slug);
      const inserted = !existing;
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
