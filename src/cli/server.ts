// `site-admin server` — start the Fastify process.
// Thin shim that delegates to src/server.ts so both entry points share code.

import type { FastifyInstance } from 'fastify';

import { startServer } from '../server.ts';

// Returns the listening instance. bin/site-admin ignores it — the
// process runs until a signal — but a test needs something to close.
export default async function runServer(args: string[]): Promise<FastifyInstance> {
  const portFlag = args.indexOf('--port');
  const port = portFlag !== -1 ? Number(args[portFlag + 1]) : undefined;
  return startServer({ port });
}
