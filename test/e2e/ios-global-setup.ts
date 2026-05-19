// Global setup for TestMu AI iOS Playwright suite.
// Starts the local test server and the LT tunnel that exposes it as
// localhost.lambdatest.com:PORT on the remote device.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// @lambdatest/node-tunnel is CJS; use createRequire for ESM interop.
const require = createRequire(import.meta.url);
const LambdaTunnel = require('@lambdatest/node-tunnel') as new () => {
  start(args: { user?: string; key?: string; tunnelName?: string }): Promise<boolean>;
  stop(): Promise<boolean>;
};

const PORT = 3790;
// Listen on all interfaces so the LT tunnel can reach the server.
const HOST = '0.0.0.0';

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
  });
}

function waitForServer(url: string, timeout = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    function attempt(): void {
      http
        .get(url, (res) => {
          res.resume();
          res.statusCode === 200 ? resolve() : schedule();
        })
        .on('error', schedule);
    }
    function schedule(): void {
      if (Date.now() >= deadline) {
        reject(new Error(`Server not ready within ${timeout}ms`));
        return;
      }
      setTimeout(attempt, 300);
    }
    attempt();
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (await isPortInUse(PORT)) {
    console.log(`[ios-setup] server already running on port ${PORT} — skipping spawn`);
    return async () => {};
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-e2e-ios-'));

  const server = spawn(
    'node',
    [
      '--no-warnings=ExperimentalWarning',
      '--experimental-strip-types',
      path.join(process.cwd(), 'test/e2e/server-runner.ts')
    ],
    {
      env: {
        ...process.env,
        SITE_ROOT: tmpRoot,
        PORT: String(PORT),
        HOST,
        ADMIN_TOKEN: 'e2e-test-token-do-not-use-in-prod'
      },
      stdio: 'inherit'
    }
  );

  server.on('error', (err) => console.error('[ios-setup] server spawn error:', err));

  await waitForServer(`http://127.0.0.1:${PORT}/health`);
  console.log(`[ios-setup] test server ready — SITE_ROOT=${tmpRoot}`);

  const tunnel = new LambdaTunnel();
  await tunnel.start({
    user: process.env.LT_USERNAME,
    key: process.env.LT_ACCESS_KEY,
    tunnelName: 'rkr-blog'
  });
  console.log('[ios-setup] LT tunnel started');

  return async () => {
    await tunnel.stop();
    console.log('[ios-setup] LT tunnel stopped');
    server.kill('SIGTERM');
    console.log('[ios-setup] test server stopped');
  };
}
