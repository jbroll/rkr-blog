// Experimental JSON-blocks editor save:
//   POST /admin/blocks/:slug { tree, baseVersion? } — validate and store
//   one page; a baseVersion that no longer matches the file is a 409.
//
// The URL slug wins: it names the file and overwrites fields.slug, so a
// rename is a save under a new slug plus a delete of the old file (the
// delete half is still manual). Invalid trees are 400, never stored.

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { writeFileAtomicSync } from '../lib/atomic-write.ts';
import { requireUser } from '../lib/auth-middleware.ts';
import {
  blockFileVersion,
  findBlockFile,
  listBlockPages,
  readBlockPage
} from '../lib/block-pages.ts';
import { type BlockTree, parseBlockTree, rawTreeProblem, validateForSave } from '../lib/blocks.ts';
import { renderEditBody } from '../lib/blocks-edit-render.ts';
import { BUILD_HEADER, STALE_CLIENT_STATUS } from '../lib/build-contract.ts';
import { staleClientRejection } from '../lib/client-build.ts';
import type { SiteConfig } from '../lib/config.ts';
import type { Db } from '../lib/db.ts';
import { loadMacroLibrary, ROOT_MACROS } from '../lib/macro-library.ts';
import { readAllIndexedPosts, readIndexedPostBySlug, runReindex } from '../lib/post-index.ts';
import { dropIndexedPost, reindexBlockPage } from '../lib/post-index-blocks.ts';
import { listPosts } from '../lib/posts.ts';
import { RESERVED_SLUGS } from '../lib/reserved-slugs.ts';
import {
  setAdminEditorSecurityHeaders,
  setPublicSecurityHeaders
} from '../lib/security-headers.ts';
import { serverAssets } from '../lib/site-assets.ts';
import { renderBlocksEditPage } from '../templates/admin-blocks-edit.ts';
import { renderBlocksNewPage } from '../templates/admin-blocks-new.ts';
import {
  PAGES_LIST_CSS,
  type PageRow,
  renderAdminPagesIndex
} from '../templates/admin-pages-list.ts';
import { renderBlocksPage } from '../templates/blocks.ts';
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

const TEXT_FIELDS = ['title', 'subtitle', 'status', 'date', 'excerpt'] as const;

/** Page fields as sent; throws naming the first field of the wrong type,
 * since the index and Page settings read these as strings. */
function checkFields(raw: unknown): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('fields must be an object');
  const fields = raw as Record<string, unknown>;
  for (const key of TEXT_FIELDS) {
    if (fields[key] !== undefined && typeof fields[key] !== 'string') {
      throw new Error(`fields.${key} must be a string`);
    }
  }
  const tags = fields.tags;
  if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === 'string'))) {
    throw new Error('fields.tags must be a list of strings');
  }
  return fields;
}

/** Stored pages with status and last-change time. The index wins; a page
 * saved but not yet indexed falls back to its file. */
function pageRows(siteRoot: string, db: Db | undefined): PageRow[] {
  const indexed = new Map((db ? readAllIndexedPosts(db) : []).map((p) => [p.slug, p]));
  return listBlockPages(siteRoot)
    .map(({ slug, title }) => {
      const hit = indexed.get(slug);
      if (hit) {
        return { slug, title, status: hit.status, updatedAt: hit.updated_at };
      }
      const file = findBlockFile(siteRoot, slug);
      const status = readStoredFields(file).status === 'published' ? 'published' : 'draft';
      const updatedAt = file ? fs.statSync(file).mtime.toISOString() : '';
      return { slug, title, status, updatedAt } satisfies PageRow;
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
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

  fastify.get('/admin/blocks/macros', { ...guard }, async (req, _reply) => {
    const lib = loadMacroLibrary(`${siteRoot}/macros`, req.log);
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
      return { slug, title: page.title, tree: { ...page.tree, fields: page.fields } };
    }
  );

  fastify.get<{ Querystring: { q?: string } }>(
    '/admin/blocks',
    { ...guard },
    async (req, reply) => {
      setPublicSecurityHeaders(reply);
      const assets = serverAssets('/admin/static');
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const all = pageRows(siteRoot, opts.db);
      const rows = q ? all.filter((r) => r.title.toLowerCase().includes(q.toLowerCase())) : all;
      return reply.type('text/html; charset=utf-8').send(
        renderBlocksPage({
          site: getSite(),
          assets,
          title: 'Pages',
          bodyHtml: renderAdminPagesIndex(rows, { q, total: all.length }),
          css: PAGES_LIST_CSS,
          isAdmin: true,
          adminPwa: true
        })
      );
    }
  );

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
      if (RESERVED_SLUGS.has(slug)) {
        return sendNewForm(reply, 400, {
          title,
          slug,
          error: `The address /${slug} is used by the site. Choose another slug.`
        });
      }
      const indexed = opts.db ? readIndexedPostBySlug(opts.db, slug) : undefined;
      if (indexed || fs.existsSync(blockFile(siteRoot, slug)) || findBlockFile(siteRoot, slug)) {
        return sendNewForm(reply, 409, {
          title,
          slug,
          error: `A page with the slug "${slug}" already exists. Choose another.`
        });
      }
      const dest = blockFile(siteRoot, slug);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      writeFileAtomicSync(
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
          version: page.version,
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

  // The editor's Delete page. Another file claiming the slug, or a
  // markdown post not yet archived, takes the slug back.
  fastify.post<{ Params: { slug: string } }>(
    '/admin/blocks/:slug/delete',
    { ...guard },
    async (req, reply) => {
      const { slug } = req.params;
      const file = VALID_SLUG.test(slug) ? findBlockFile(siteRoot, slug) : null;
      if (!file) return reply.code(404).send({ error: 'not found' });
      fs.unlinkSync(file);
      const db = opts.db;
      if (!db || listPosts(siteRoot).some((p) => p.slug === slug)) runReindex(siteRoot);
      else if (findBlockFile(siteRoot, slug)) reindexBlockPage(db, siteRoot, slug);
      else dropIndexedPost(db, slug);
      return { deleted: slug };
    }
  );

  fastify.post<{ Params: { slug: string }; Body: unknown }>(
    '/admin/blocks/:slug',
    { ...guard },
    async (req, reply) => {
      const { slug } = req.params;
      if (!VALID_SLUG.test(slug)) return reply.code(404).send({ error: 'not found' });
      // An editor bundle older than the server saves through a stale contract.
      const stale = staleClientRejection(req.headers[BUILD_HEADER]);
      if (stale) return reply.code(STALE_CLIENT_STATUS).send(stale);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const invalid = (problem: { message: string; path?: number[] }) =>
        reply.code(400).send({ error: 'invalid', ...problem });
      const raw = body && typeof body === 'object' ? (body as { tree?: unknown }).tree : null;
      if (!raw || typeof raw !== 'object') return invalid({ message: 'missing tree' });
      const rec = raw as { body?: unknown; fields?: unknown };
      const structural = rawTreeProblem(rec.body);
      if (structural) return invalid(structural);
      let parsed: BlockTree;
      try {
        parsed = parseBlockTree({ version: 1, body: rec.body });
      } catch (err) {
        return invalid({ message: (err as Error).message });
      }
      let macroNames: Set<string>;
      try {
        macroNames = new Set(loadMacroLibrary(`${siteRoot}/macros`, req.log).keys());
      } catch (err) {
        req.log.error({ err }, 'macro library failed to load');
        return reply.code(500).send({ error: 'macro library unavailable' });
      }
      const problem = validateForSave(parsed, macroNames);
      if (problem) return invalid(problem);
      let existing: string | null = null;
      let tree: BlockTree & { fields: Record<string, unknown> };
      try {
        existing = findBlockFile(siteRoot, slug);
        tree = {
          ...parsed,
          fields: { ...readStoredFields(existing), ...checkFields(rec.fields), slug }
        };
      } catch (err) {
        return invalid({ message: (err as Error).message });
      }
      const dest = existing ?? blockFile(siteRoot, slug);
      if (!existing && fs.existsSync(dest)) {
        return reply.code(409).send({ error: 'slug collides with an existing file' });
      }
      // Scripted clients (wp-push) send no baseVersion and always overwrite.
      const base = body.baseVersion;
      if (typeof base === 'string' && existing) {
        const current = blockFileVersion(existing);
        if (current !== base) return reply.code(409).send({ error: 'conflict', version: current });
      }
      const inserted = !existing;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // Public reads of this file run concurrently; rename never shows them a partial page.
      writeFileAtomicSync(dest, `${JSON.stringify(tree, null, 2)}\n`);
      const version = blockFileVersion(dest);

      // Public / and /:slug read the DB index, so a save updates this
      // page's row before replying. Only this page: a full reindex parses
      // every post and blocks the event loop for most of a second.
      if (opts.db) reindexBlockPage(opts.db, siteRoot, slug);
      else runReindex(siteRoot);

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

      return { slug, inserted, version };
    }
  );
}
