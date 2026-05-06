// `site-admin server` — start the Fastify process.
// Thin shim that delegates to bin/server.js so both entry points share code.

import { startServer } from '../server.js';

export default async function runServer(args) {
  const portFlag = args.indexOf('--port');
  const port = portFlag !== -1 ? Number(args[portFlag + 1]) : undefined;
  await startServer({ port });
}
