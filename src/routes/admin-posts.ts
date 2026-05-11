// Admin posts listing + delete.
//
// Extracted from src/routes/admin.ts to keep the size cap honest.
// /admin/posts is the admin-only listing of drafts + published; the
// public /:slug only shows published, so drafts would be unreachable
// after navigating away from the editor without this surface.

import fs from 'node:fs';
import path from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { readAllIndexedPosts, runReindex } from '../cli/reindex.ts';
import { siteConfig } from '../lib/config.ts';
import type { Db } from '../lib/db.ts';
import { renderAdminPostsPage } from '../templates/admin-posts.ts';

const MAX_SLUG_LENGTH = 100;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

export interface AdminPostsRoutesOpts {
  siteRoot: string;
  db: Db;
  /** Same `{ preHandler }` shape adminRoutes uses; empty when
   * `requireAuth` is off. */
  guard: Record<string, unknown>;
}

export function registerAdminPostsRoutes(
  fastify: FastifyInstance,
  opts: AdminPostsRoutesOpts
): void {
  const { siteRoot, db, guard } = opts;
  const site = siteConfig();

  // The delete form on the listing submits as
  // application/x-www-form-urlencoded. Register a parser so Fastify
  // doesn't 415 the request body; the route reads URL params, so
  // the parsed body is unused.
  if (!fastify.hasContentTypeParser('application/x-www-form-urlencoded')) {
    fastify.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          const params = new URLSearchParams(body as string);
          done(null, Object.fromEntries(params));
        } catch (err) {
          /* c8 ignore next -- URLSearchParams accepts almost any string */
          done(err as Error, undefined);
        }
      }
    );
  }

  fastify.get('/admin/posts', { ...guard }, async (_req, reply) => {
    const rows = readAllIndexedPosts(db).map((r) => ({
      slug: r.slug,
      title: r.title,
      status: r.status,
      updatedAt: r.updated_at
    }));
    return reply.type('text/html; charset=utf-8').send(renderAdminPostsPage({ site, posts: rows }));
  });

  // Method is POST (not DELETE) so a plain HTML <form> can drive it
  // from the listing; the CSRF / Origin guard already catches cross-
  // origin POSTs. Removes the markdown file + reindexes. Image
  // originals + sidecars stay (often shared between posts; the
  // /admin/reset path is the wholesale wipe).
  fastify.post<{ Params: { slug: string } }>(
    '/admin/posts/:slug/delete',
    { ...guard },
    async (request: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
      const { slug } = request.params;
      if (typeof slug !== 'string' || slug.length > MAX_SLUG_LENGTH || !SLUG_RE.test(slug)) {
        return reply.code(400).send({ error: 'invalid slug' });
      }
      const filePath = path.join(siteRoot, 'content', 'posts', `${slug}.md`);
      if (!fs.existsSync(filePath)) {
        return reply.code(404).send({ error: 'not found' });
      }
      await fs.promises.unlink(filePath);
      runReindex(siteRoot);
      return reply.redirect('/admin/posts', 303);
    }
  );
}
