// GET /site-theme/:file and /admin/site-theme/:file serve stylesheets from
// `<site>/themes/`. Outside /static so production Apache passes them to Node.

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

const THEME_FILE = /^[a-z][a-z0-9-]*\.css$/;

export interface SiteThemeRoutesOpts {
  siteRoot: string;
}

export function registerSiteThemeRoutes(fastify: FastifyInstance, opts: SiteThemeRoutesOpts): void {
  const dir = path.join(opts.siteRoot, 'themes');
  const serve = async (request: { params: unknown }, reply: FastifyReply) => {
    const { file } = request.params as { file: string };
    if (!THEME_FILE.test(file)) return reply.callNotFound();
    let css: Buffer;
    try {
      css = await fs.promises.readFile(path.join(dir, file));
    } catch {
      return reply.callNotFound();
    }
    return reply
      .type('text/css; charset=utf-8')
      .header('X-Content-Type-Options', 'nosniff')
      .send(css);
  };
  fastify.get('/site-theme/:file', serve);
  fastify.get('/admin/site-theme/:file', serve);
}
