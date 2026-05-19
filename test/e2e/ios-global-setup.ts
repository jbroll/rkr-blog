// Global setup for BrowserStack iOS Playwright suite.
// The BrowserStack SDK bypasses Playwright's native webServer lifecycle,
// so we start the test server manually here.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PORT = 3790;
// Listen on all interfaces. BS Local routes bs-local.com to 127.0.0.1 on
// the test machine; 0.0.0.0 ensures we accept those connections.
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

  return async () => {
    server.kill('SIGTERM');
    console.log('[ios-setup] test server stopped');
  };
}
