// Admin posts listing + delete.
//
// Extracted from src/routes/admin.ts to keep the size cap honest.
// /admin/posts is the admin-only listing of drafts + published; the
// public /:slug only shows published, so drafts would be unreachable
// after navigating away from the editor without this surface.

import fs from 'node:fs';
import path from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { runReindex } from '../cli/reindex.ts';

const MAX_SLUG_LENGTH = 100;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;

export interface AdminPostsRoutesOpts {
  siteRoot: string;
  /** Same `{ preHandler }` shape adminRoutes uses; empty when
   * `requireAuth` is off. */
  guard: Record<string, unknown>;
}

export function registerAdminPostsRoutes(
  fastify: FastifyInstance,
  opts: AdminPostsRoutesOpts
): void {
  const { siteRoot, guard } = opts;

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

  // /admin/posts used to be the standalone admin posts list. The
  // homepage now doubles as that list for authed visitors (see
  // public.ts: drafts + status / pin / delete render when req.user
  // is set), so this route is a 301 to "/". Kept around for the few
  // bookmarks or old admin-strip clicks pointing here.
  fastify.get('/admin/posts', { ...guard }, async (_req, reply) => {
    return reply.redirect('/', 301);
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
      return reply.redirect('/', 303);
    }
  );

  // Frontmatter-only status flip. Driven by the per-row status select
  // on /admin/posts (form-encoded POST → 303 redirect lands back on
  // the listing). Doesn't touch the body markdown — useful when an
  // author wants to publish/unpublish without re-opening the editor.
  fastify.post<{ Params: { slug: string }; Body: { status?: unknown } }>(
    '/admin/posts/:slug/status',
    { ...guard },
    async (request, reply) => {
      const { slug } = request.params;
      if (typeof slug !== 'string' || slug.length > MAX_SLUG_LENGTH || !SLUG_RE.test(slug)) {
        return reply.code(400).send({ error: 'invalid slug' });
      }
      const status = request.body?.status;
      if (status !== 'draft' && status !== 'published') {
        return reply.code(400).send({ error: 'status must be draft or published' });
      }
      const filePath = path.join(siteRoot, 'content', 'posts', `${slug}.md`);
      if (!fs.existsSync(filePath)) {
        return reply.code(404).send({ error: 'not found' });
      }
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const updated = setStatusInFrontmatter(raw, status);
      if (updated === null) {
        return reply.code(400).send({ error: 'post missing frontmatter' });
      }
      if (updated !== raw) {
        await fs.promises.writeFile(filePath, updated, 'utf8');
        runReindex(siteRoot);
      }
      return reply.redirect('/', 303);
    }
  );
}

/** Swap the `status:` line inside the YAML frontmatter block. Returns
 * null if the file lacks frontmatter (`---` open + close) — we don't
 * want to invent one for a malformed post. Returns the unchanged raw
 * string when status was already correct so the caller can skip the
 * reindex. */
function setStatusInFrontmatter(raw: string, newStatus: 'draft' | 'published'): string | null {
  if (!raw.startsWith('---\n')) return null;
  const fmEnd = raw.indexOf('\n---', 4);
  if (fmEnd < 0) return null;
  const fm = raw.slice(0, fmEnd);
  const body = raw.slice(fmEnd);
  const re = /^status: (draft|published)$/m;
  if (re.test(fm)) {
    return fm.replace(re, `status: ${newStatus}`) + body;
  }
  // No status line — append one before the closing fence so the next
  // parsePost sees it.
  return `${fm}\nstatus: ${newStatus}${body}`;
}
