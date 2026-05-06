#!/usr/bin/env -S node --no-warnings=ExperimentalWarning --experimental-strip-types
// Fastify entry point. See src/server.ts for the app factory.

import { startServer } from '../src/server.ts';

startServer().catch((err) => {
  console.error('server failed to start:', err);
  process.exit(1);
});
