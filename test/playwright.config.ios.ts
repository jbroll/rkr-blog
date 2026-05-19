// Playwright config for running the e2e suite on TestMu AI (formerly LambdaTest)
// using real iOS Safari devices.
//
// Run: npm run test:e2e:ios
//
// How it works:
//   Standard `npx playwright test` — no SDK wrapper. Each project connects to
//   TestMu AI's Playwright endpoint via connectOptions.wsEndpoint with device
//   capabilities encoded in the URL. ios-global-setup.ts starts the local test
//   server and the LT tunnel. The tunnel exposes localhost:PORT as
//   localhost.lambdatest.com:PORT on the remote device.
//
// Prerequisites:
//   - LT_USERNAME and LT_ACCESS_KEY in environment
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
// localhost.lambdatest.com is the hostname the LT tunnel maps to the test
// machine on real iOS devices. 'localhost' on a real iPhone goes to the
// device's own loopback; this hostname routes through the tunnel.
const BASE_URL = `http://localhost.lambdatest.com:${PORT}`;

function ltEndpoint(deviceName: string, platformVersion: string): string {
  const caps = {
    'LT:Options': {
      platformName: 'ios',
      deviceName,
      platformVersion,
      isRealMobile: true,
      build: 'ios-safari-opfs',
      name: 'OPFS smoke test',
      user: process.env.LT_USERNAME,
      accessKey: process.env.LT_ACCESS_KEY,
      tunnel: true,
      tunnelName: 'rkr-blog',
      network: true,
      console: true,
      video: true
    }
  };
  return `wss://cdp.lambdatest.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(caps))}`;
}

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
  globalSetup: './e2e/ios-global-setup.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'off',
    screenshot: 'off'
  },
  grep: /settings → Create About/,
  projects: [
    {
      name: 'iPhone 16 Pro Max iOS 18',
      use: { connectOptions: { wsEndpoint: ltEndpoint('iPhone 16 Pro Max', '18') } }
    }
  ]
});
