// Playwright config for running the e2e suite on BrowserStack Automate
// (macOS Safari via playwright-webkit). Run via:
//   npm run test:e2e:ios
// which invokes: browserstack-node-sdk playwright test --config test/playwright.config.ios.ts
//
// Credentials are read from secrets.env (gitignored) if not already in the
// environment. Never commit secrets.env or hardcode credentials here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Load credentials from secrets.env if not already set in the environment.
const secretsPath = path.join(process.cwd(), 'secrets.env');
if (fs.existsSync(secretsPath)) {
  for (const line of fs.readFileSync(secretsPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-e2e-ios-'));
// Use a different port so a local chromium run can be left running alongside.
const PORT = 3790;
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 2,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  // No globalTeardown — V8 coverage collection is Chromium-only (CDP).
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    headless: true,
    contextOptions: { reducedMotion: 'no-preference' }
  },
  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], contextOptions: { reducedMotion: 'no-preference' } }
    }
  ],
  webServer: {
    command:
      'node --no-warnings=ExperimentalWarning --experimental-strip-types e2e/server-runner.ts',
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
