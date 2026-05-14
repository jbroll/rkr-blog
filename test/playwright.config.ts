// Playwright e2e configuration. Boots the rkroll-cms server via
// test-e2e/server-runner.ts (fresh tmp DB + dummy OAuth wiring) and
// runs browser tests against it.
//
// Run: `npm run test:e2e`. Not part of the pre-commit pipeline —
// e2e is slow and needs a browser; use it before pushing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-e2e-'));
const PORT = 3789;
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: './test/e2e',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1, // single worker so the shared server isn't raced
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  // V8 coverage capture lives in test/e2e/coverage-fixtures.ts (per-
  // test) + test/e2e/global-teardown.ts (final report generation).
  // mcr handles source-map resolution so reports show src/admin/main.ts
  // line coverage rather than the bundled URL.
  globalTeardown: './test/e2e/global-teardown.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    headless: true,
    // Headless Chromium defaults prefers-reduced-motion=reduce in
    // some versions; the carousel autoplay test (and any future
    // animation-aware test) needs the user-default "no-preference"
    // so the public-site code follows the same code path real
    // visitors do.
    reducedMotion: 'no-preference'
  },
  projects: [
    {
      name: 'chromium',
      // Override after spread so devices['Desktop Chrome'] doesn't
      // re-set reducedMotion=reduce in some Playwright versions.
      use: { ...devices['Desktop Chrome'], reducedMotion: 'no-preference' }
    }
  ],
  webServer: {
    command:
      'node --no-warnings=ExperimentalWarning --experimental-strip-types test/e2e/server-runner.ts',
    url: `${BASE_URL}/health`,
    timeout: 30_000,
    reuseExistingServer: !process.env.CI,
    env: {
      SITE_ROOT: tmpRoot,
      PORT: String(PORT),
      HOST,
      ADMIN_TOKEN: 'e2e-test-token-do-not-use-in-prod'
    }
  }
});
