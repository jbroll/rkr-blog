// Fastify app factory. Exports buildApp() so tests can drive the server
// without binding a port, and startServer() for the bin entry point.

import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import Fastify from 'fastify';

import { paths, serverConfig } from './lib/config.ts';
import { type Db, open } from './lib/db.ts';
import { workQueue } from './lib/jobs.ts';
import adminRoutes from './routes/admin.ts';
import publicRoutes from './routes/public.ts';

const UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024; // 100 MiB cap on a single file

export interface BuildAppOpts {
  logger?: FastifyServerOptions['logger'];
  siteRoot?: string;
  /** When provided, GET /img/* registers and (unless suppressed) the worker starts. */
  db?: Db;
  /** Wall-clock budget for synchronous render on cache miss (ms). Default 30s. */
  renderBudgetMs?: number;
  /** Disable starting the in-process worker (e.g. in tests). Default true if db provided. */
  startWorker?: boolean;
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

  if (opts.db) {
    await app.register(publicRoutes, {
      siteRoot,
      db: opts.db,
      renderBudgetMs: opts.renderBudgetMs
    });

    if (opts.startWorker !== false) {
      const ctrl = workQueue({
        db: opts.db,
        ctx: { siteRoot }
      });
      app.addHook('onClose', async () => {
        await ctrl.stop();
      });
    }
  }

  return app;
}

export async function startServer(opts: StartServerOpts = {}): Promise<FastifyInstance> {
  const cfg = serverConfig();
  const p = paths();
  const db = open(p.db);

  const app = await buildApp({
    logger: { level: cfg.logLevel },
    siteRoot: opts.siteRoot,
    db
  });
  app.addHook('onClose', () => {
    db.close();
  });

  const port = opts.port ?? cfg.port;
  const host = opts.host ?? cfg.host;

  await app.listen({ port, host });
  console.log(`rkroll-cms listening on http://${host}:${port}`);
  return app;
}
