// Playwright config for running the e2e suite on BrowserStack Automate
// using real iOS Safari devices.
//
// Run: npm run test:e2e:ios
//
// How it works:
//   The BrowserStack SDK (npx browserstack-node-sdk playwright test) reads
//   browserstack.yml for platform/credentials and manages BrowserStack Local
//   automatically. ios-global-setup.ts starts our local test server manually
//   (the SDK bypasses Playwright's native webServer lifecycle). BS Local
//   tunnels localhost:PORT from the remote device back to this machine.
//
// Prerequisites:
//   - BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY in environment
//     (or in secrets.env, which the npm script sources)
//   - npm run build:admin && npm run build:site  (bundles must exist)

import fs from 'node:fs';
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
// bs-local.com is the hostname BrowserStack Local maps to the test machine
// on real iOS devices. Safari on device navigating to 'localhost' goes to
// the phone's own loopback; 'bs-local.com' routes through the BS Local tunnel.
const BASE_URL = `http://bs-local.com:${PORT}`;

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
  // The BrowserStack SDK bypasses Playwright's webServer lifecycle so the
  // test server is started in globalSetup instead.
  globalSetup: './e2e/ios-global-setup.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'off',
    screenshot: 'off'
  },
  // Project names follow BrowserStack SDK convention:
  //   {browser}@{deviceName}:{osVersion}@browserstack-mobile
  projects: [
    { name: 'safari@iPhone 16 Pro Max:18@browserstack-mobile' },
    { name: 'safari@iPhone 15 Pro Max:17@browserstack-mobile' }
  ]
});
