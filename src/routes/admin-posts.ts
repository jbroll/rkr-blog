// Admin posts listing compatibility redirect.
//
// The standalone admin posts list is gone: the homepage doubles as
// that list for authed visitors, and every write now happens in the
// JSON blocks editor (/admin/blocks*). This URL survives as a 301 so
// old bookmarks and admin-strip clicks land somewhere useful.
//
// The markdown write endpoints that used to live here (delete and
// frontmatter-only status flip) were retired in the JSON cutover.

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
    return reply.redirect('/', 301);
  });
}
