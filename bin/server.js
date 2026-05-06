#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
// Fastify entry point. See src/server.js for the app factory.

import { startServer } from '../src/server.js';

startServer().catch((err) => {
  console.error('server failed to start:', err);
  process.exit(1);
});
