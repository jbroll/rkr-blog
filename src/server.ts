// Fastify app factory. Exports buildApp() so tests can drive the server
// without binding a port, and startServer() for the bin entry point.

import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import Fastify from 'fastify';

import { paths, serverConfig } from './lib/config.ts';
import adminRoutes from './routes/admin.ts';

const UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024; // 100 MiB cap on a single file

export interface BuildAppOpts {
  logger?: FastifyServerOptions['logger'];
  siteRoot?: string;
}

export interface StartServerOpts {
  port?: number;
  host?: string;
  siteRoot?: string;
}

export async function buildApp(opts: BuildAppOpts = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false
  });

  const siteRoot = opts.siteRoot ?? paths().root;

  await app.register(multipart, {
    limits: {
      fileSize: UPLOAD_LIMIT_BYTES,
      files: 1
    }
  });

  app.get('/health', async () => ({ ok: true }));

  await app.register(adminRoutes, { siteRoot });

  return app;
}

export async function startServer(opts: StartServerOpts = {}): Promise<FastifyInstance> {
  const cfg = serverConfig();
  const app = await buildApp({
    logger: { level: cfg.logLevel },
    siteRoot: opts.siteRoot
  });
  const port = opts.port ?? cfg.port;
  const host = opts.host ?? cfg.host;

  await app.listen({ port, host });
  console.log(`rkroll-cms listening on http://${host}:${port}`);
  return app;
}
