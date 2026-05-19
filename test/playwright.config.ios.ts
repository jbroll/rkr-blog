// Playwright config for running the e2e suite on BrowserStack Automate
// (macOS Safari via playwright-webkit). Uses BrowserStack's CDP WebSocket
// endpoint so tests actually execute on their cloud machines.
//
// Run: npm run test:e2e:ios
//
// Prerequisites:
//   - BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY in environment
//     (or in secrets.env, which this config reads at startup)
//   - npm run build:admin && npm run build:site  (bundles must exist)
//
// How it works:
//   globalSetup starts BrowserStack Local (tunnel → local webServer).
//   Each project's connectOptions wires to BS's cdp.browserstack.com
//   endpoint. The remote Safari browser navigates to localhost:PORT,
//   which the BS Local tunnel proxies to the local webServer process.
//   globalTeardown stops the local webServer then the BS Local tunnel.

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
// Remote browsers access the local server via BrowserStack Local tunnel.
// The tunnel maps 'localhost' on BrowserStack's machine → our HOST:PORT.
const BASE_URL = `http://localhost:${PORT}`;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-e2e-ios-'));

// Build a BrowserStack CDP WebSocket endpoint for a given platform.
function bsCdpEndpoint(browser: string, os: string, osVersion: string, name: string): string {
  const caps = {
    browser,
    os,
    os_version: osVersion,
    name,
    build: 'webkit-safari',
    'browserstack.username': process.env.BROWSERSTACK_USERNAME ?? '',
    'browserstack.accessKey': process.env.BROWSERSTACK_ACCESS_KEY ?? '',
    'browserstack.local': 'true',
    // Must match the installed @playwright/test version exactly.
    'client.playwrightVersion': '1.59.1'
  };
  return `wss://cdp.browserstack.com/playwright?caps=${encodeURIComponent(JSON.stringify(caps))}`;
}

export default defineConfig({
  testDir: './e2e',
  // Run only a small smoke set while validating the BrowserStack infrastructure.
  // Expand to /.*\.spec\.ts$/ once end-to-end routing is confirmed.
  testMatch: /\/(login|about-page)\.spec\.ts$/,
  fullyParallel: false,
  // One worker: BS Automate sessions are serialised to avoid port races
  // on the shared local webServer.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  globalSetup: './e2e/bs-local-setup.ts',
  globalTeardown: './e2e/bs-local-teardown.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry'
  },
  projects: [
    // Single platform during infrastructure validation. Add webkit-ventura
    // (and others) once sessions are confirmed on the dashboard.
    {
      name: 'webkit-sonoma',
      use: {
        connectOptions: {
          wsEndpoint: bsCdpEndpoint('playwright-webkit', 'OS X', 'Sonoma', 'rkr-blog webkit Sonoma')
        }
      }
    }
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
