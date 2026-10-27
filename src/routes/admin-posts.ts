// GET /admin/posts: a 301 to /posts for old bookmarks. Page writes, including
// status and delete, live in admin-blocks.ts.

import type { FastifyInstance } from 'fastify';

export interface AdminPostsRoutesOpts {
  /** Same `{ preHandler }` shape adminRoutes uses; empty when
   * `requireAuth` is off. */
  guard: Record<string, unknown>;
}

export function registerAdminPostsRoutes(
  fastify: FastifyInstance,
  opts: AdminPostsRoutesOpts
): void {
  const { guard } = opts;

  fastify.get('/admin/posts', { ...guard }, async (_req, reply) => {
    return reply.redirect('/posts', 301);
  });
}
