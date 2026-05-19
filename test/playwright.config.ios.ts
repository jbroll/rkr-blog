// Playwright config for running the e2e suite on BrowserStack Automate
// using real iOS Safari devices.
//
// Run: npm run test:e2e:ios
//
// How it works:
//   The BrowserStack SDK (npx browserstack-node-sdk playwright test) reads
//   browserstack.yml for platform/credentials and manages BrowserStack Local
//   automatically. The webServer starts our local test server; BS Local
//   tunnels localhost:PORT from the remote device back to this machine.
//
// Prerequisites:
//   - BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY in environment
//     (or in secrets.env, which the npm script sources)
//   - npm run build:admin && npm run build:site  (bundles must exist)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

// Load credentials from secrets.env if not already set in the environment.
// secrets.env is gitignored — never committed.
const secretsPath = path.join(process.cwd(), 'secrets.env');
if (fs.existsSync(secretsPath)) {
  for (const line of fs.readFileSync(secretsPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
  }
}

const PORT = 3790;
const HOST = '127.0.0.1';
// Remote devices access the local server via BrowserStack Local tunnel.
// The tunnel maps 'localhost' on the device → our HOST:PORT.
const BASE_URL = `http://localhost:${PORT}`;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-e2e-ios-'));

export default defineConfig({
  testDir: './e2e',
  // OPFS smoke tests while validating iOS storage support.
  testMatch: /\/about-page\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  // Real devices are slower than headless; give them extra time.
  timeout: 90_000,
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry'
  },
  // Project names follow BrowserStack SDK convention:
  //   {browser}@{deviceName}:{osVersion}@browserstack-mobile
  projects: [
    { name: 'safari@iPhone 16 Pro Max:18@browserstack-mobile' },
    { name: 'safari@iPhone 15 Pro Max:17@browserstack-mobile' }
  ],
  webServer: {
    command:
      'node --no-warnings=ExperimentalWarning --experimental-strip-types e2e/server-runner.ts',
    url: `http://${HOST}:${PORT}/health`,
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
