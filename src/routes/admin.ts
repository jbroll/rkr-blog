// Admin routes. Authentication is added in Step 9 — for now these are open.
//
// Routes:
//   GET  /admin/editor      → SPA shell (loads /admin/static/main.js)
//   GET  /admin/static/*    → compiled admin bundle from static/admin/
//   POST /admin/upload      → multipart image ingest (routed to ingestStream)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

import { paths } from '../lib/config.ts';
import { ingestStream } from '../lib/originals.ts';
import { renderAdminPage } from '../templates/admin.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Repo layout: src/routes/admin.ts → ../../static/admin
const REPO_ADMIN_BUNDLE_DIR = path.resolve(__dirname, '..', '..', 'static', 'admin');

export interface AdminRoutesOpts {
  siteRoot?: string;
  /**
   * Where the compiled admin bundle lives on disk. Defaults to
   * <repo>/static/admin (the build:admin tsc output).
   */
  adminBundleDir?: string;
}

export default async function adminRoutes(
  fastify: FastifyInstance,
  opts: AdminRoutesOpts = {}
): Promise<void> {
  const siteRoot = opts.siteRoot ?? paths().root;
  const bundleDir = opts.adminBundleDir ?? REPO_ADMIN_BUNDLE_DIR;

  // Static serving for the compiled admin bundle. Only registers if the
  // build directory exists — saves tests from needing to run build:admin.
  if (fs.existsSync(bundleDir)) {
    await fastify.register(fastifyStatic, {
      root: bundleDir,
      prefix: '/admin/static/',
      decorateReply: false
    });
  }

  fastify.get('/admin/editor', async (_req, reply) => {
    return reply
      .type('text/html; charset=utf-8')
      .send(renderAdminPage({ bundleUrl: '/admin/static/main.js' }));
  });

  fastify.post('/admin/upload', async (request, reply) => {
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: 'no file part' });

    try {
      const result = await ingestStream({
        stream: part.file,
        siteRoot,
        source: { kind: 'upload', originalName: part.filename ?? null }
      });

      // @fastify/multipart sets file.truncated when the size limit was hit.
      if (part.file.truncated) {
        return reply.code(413).send({ error: 'file too large' });
      }

      return {
        id: result.id,
        bytes: result.bytes,
        deduplicated: result.deduplicated,
        ext: result.ext
      };
    } catch (err) {
      request.log.error({ err }, 'upload failed');
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
