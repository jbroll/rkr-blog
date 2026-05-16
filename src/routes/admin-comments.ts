// /admin/comments — moderation list + approve/reject/delete actions.
// Mirrors the registerAdminTagsRoute pattern: opens the on-disk DB from
// siteRoot, applies the shared `guard` (requireUser when auth is wired).

import path from 'node:path';

import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { getCommentById, listForModeration, setCommentStatus } from '../lib/comments.ts';
import { open } from '../lib/db.ts';
import { renderAdminCommentsPage } from '../templates/admin-comments.ts';

export interface AdminCommentsRouteOpts {
  siteRoot: string;
  guard: RouteShorthandOptions;
}

const ACTIONS = new Set(['approve', 'reject', 'delete']);

export function registerAdminCommentsRoutes(
  fastify: FastifyInstance,
  opts: AdminCommentsRouteOpts
): void {
  const { siteRoot, guard } = opts;
  const dbPath = path.join(siteRoot, 'data', 'site.db');

  fastify.get('/admin/comments', { ...guard }, async (_req, reply) => {
    const db = open(dbPath);
    try {
      return reply
        .type('text/html; charset=utf-8')
        .header('Cache-Control', 'private, no-store')
        .send(renderAdminCommentsPage(listForModeration(db)));
    } finally {
      db.close();
    }
  });

  fastify.post<{ Params: { id: string; action: string } }>(
    '/admin/comments/:id/:action',
    { ...guard },
    async (req, reply) => {
      const { action } = req.params;
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0 || !ACTIONS.has(action)) {
        return reply.code(400).send({ error: 'bad request' });
      }
      const db = open(dbPath);
      try {
        const c = getCommentById(db, id);
        if (!c) return reply.code(404).send({ error: 'comment not found' });
        if (action === 'approve') setCommentStatus(db, id, 'published');
        else if (action === 'reject') setCommentStatus(db, id, 'rejected');
        else db.prepare('DELETE FROM comments WHERE id = ?').run(id);
        return reply.code(303).header('location', '/admin/comments').send();
      } finally {
        db.close();
      }
    }
  );
}
