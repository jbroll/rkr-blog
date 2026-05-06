// `site-admin server` — start the Fastify process.
// Thin shim that delegates to src/server.ts so both entry points share code.

import { startServer } from '../server.ts';

export default async function runServer(args: string[]): Promise<void> {
  const portFlag = args.indexOf('--port');
  const port = portFlag !== -1 ? Number(args[portFlag + 1]) : undefined;
  await startServer({ port });
}
