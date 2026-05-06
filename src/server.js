// Fastify app factory. Exports buildApp() so tests can drive the server
// without binding a port, and startServer() for the bin entry point.

import Fastify from 'fastify';
import { serverConfig } from './lib/config.js';

export async function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger ?? false
  });

  app.get('/health', async () => ({ ok: true }));

  return app;
}

export async function startServer(opts = {}) {
  const cfg = serverConfig();
  const app = await buildApp({ logger: { level: cfg.logLevel } });
  const port = opts.port ?? cfg.port;
  const host = opts.host ?? cfg.host;

  await app.listen({ port, host });
  console.log(`rkroll-cms listening on http://${host}:${port}`);
  return app;
}
