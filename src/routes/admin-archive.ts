// Export and import routes for the portable SQLite archive.
// Bearer-only (same guard as /admin/reset): these are operator tools,
// not editor-reachable actions.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { FastifyInstance, RouteShorthandOptions } from 'fastify';

import { exportArchive, importArchive } from '../lib/archive.ts';

function bearerOnly(
  request: { user?: { id: number } | null },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } }
): boolean {
  if (!request.user || request.user.id !== 0) {
    reply.code(403).send({ error: 'bearer-only; cookie auth not accepted for this endpoint' });
    return false;
  }
  return true;
}

export function registerArchiveRoutes(
  fastify: FastifyInstance,
  opts: { siteRoot: string; guard: RouteShorthandOptions }
): void {
  const { siteRoot, guard } = opts;

  // GET /admin/export — build and stream the archive as a download.
  fastify.get('/admin/export', { ...guard }, async (request, reply) => {
    if (!bearerOnly(request as never, reply as never)) return;

    const date = new Date().toISOString().slice(0, 10);
    const tmp = path.join(
      siteRoot,
      'data',
      `.export-${crypto.randomBytes(6).toString('hex')}.sqlite`
    );
    fs.mkdirSync(path.dirname(tmp), { recursive: true });

    try {
      exportArchive(siteRoot, tmp);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }

    const stat = fs.statSync(tmp);
    const stream = fs.createReadStream(tmp);
    stream.on('close', () => fs.rmSync(tmp, { force: true }));

    return reply
      .header('Content-Type', 'application/vnd.sqlite3')
      .header('Content-Disposition', `attachment; filename="rkr-blog-${date}.sqlite"`)
      .header('Content-Length', String(stat.size))
      .send(stream);
  });

  // POST /admin/import[?mode=replace] — restore from an uploaded archive.
  fastify.post<{ Querystring: { mode?: string } }>(
    '/admin/import',
    { ...guard },
    async (request, reply) => {
      if (!bearerOnly(request as never, reply as never)) return;

      const part = await request.file();
      if (!part) return reply.code(400).send({ error: 'no file part' });

      const replace = request.query.mode === 'replace';
      const tmp = path.join(
        siteRoot,
        'data',
        `.import-${crypto.randomBytes(6).toString('hex')}.sqlite`
      );
      fs.mkdirSync(path.dirname(tmp), { recursive: true });

      try {
        await pipeline(part.file, fs.createWriteStream(tmp));
        const stats = importArchive(siteRoot, tmp, { replace });
        return stats;
      } catch (err) {
        // Any error from importArchive is a bad-input problem (invalid or
        // corrupt archive file), not a server error.
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: msg });
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
  );
}
