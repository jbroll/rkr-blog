// GET /admin/api/tags?q= — tag autocomplete for the editor.
//
// Returns up to 20 tag names whose names start with `q` (case-insensitive,
// SQLite LIKE). Empty or absent `q` returns the 20 most-recently-inserted
// tags alphabetically.

import path from 'node:path';

import type { FastifyInstance, RouteShorthandOptions } from 'fastify';

import type { Db } from '../lib/db.ts';
import { open } from '../lib/db.ts';

const MAX_RESULTS = 20;

export interface AdminTagsRouteOpts {
  siteRoot: string;
  guard: RouteShorthandOptions;
  db?: Db;
}

export function registerAdminTagsRoute(fastify: FastifyInstance, opts: AdminTagsRouteOpts): void {
  const { siteRoot, guard } = opts;

  fastify.get<{ Querystring: { q?: string } }>(
    '/admin/api/tags',
    { ...guard },
    async (req, reply) => {
      const q = (req.query.q ?? '').trim();
      const ownDb = !opts.db;
      const db = opts.db ?? open(path.join(siteRoot, 'data', 'site.db'));
      try {
        let rows: { name: string }[];
        if (q === '') {
          rows = db
            .prepare<{ name: string }>('SELECT name FROM tags ORDER BY name ASC LIMIT ?')
            .all(MAX_RESULTS);
        } else {
          // LIKE with % suffix = prefix match; COLLATE NOCASE = case-insensitive.
          const pattern = q.replace(/[%_\\]/g, '\\$&') + '%';
          rows = db
            .prepare<{ name: string }>(
              "SELECT name FROM tags WHERE name LIKE ? ESCAPE '\\' COLLATE NOCASE ORDER BY name ASC LIMIT ?"
            )
            .all(pattern, MAX_RESULTS);
        }
        return reply.send({ tags: rows.map((r) => r.name) });
      } finally {
        if (ownDb) db.close();
      }
    }
  );
}
