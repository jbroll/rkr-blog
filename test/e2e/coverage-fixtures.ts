// Playwright fixtures that capture V8 JS+CSS coverage per test and
// hand the raw data to monocart-coverage-reports (mcr). mcr resolves
// source maps to map the coverage from bundled URLs (e.g.
// /static/admin/main.js) back to source files (src/admin/main.ts).
//
// Per-process state: ONE mcr instance shared across all tests in a
// worker. Each test fixture runs add() with that test's data; mcr
// caches the entries to disk. global-teardown.ts calls generate()
// once at the end of the run to emit lcov + HTML reports.

import { test as baseTest } from '@playwright/test';
import { CoverageReport } from 'monocart-coverage-reports';
import { coverageOptions } from './coverage-config.ts';

// Single mcr per worker process. resetOnNavigation:false on the
// page.coverage calls means we keep accumulating across navigations
// within one test (login → editor → save → /:slug all count).
const mcr = new CoverageReport({
  ...coverageOptions,
  // Defer cache cleanup to global-teardown so the cache persists
  // across spec files (Playwright runs each .spec.ts in a fresh test
  // process when configured to fork; we use workers:1 today, but
  // append-only cache is correct under either).
  cleanCache: false
});

export const test = baseTest.extend({
  page: async ({ page }, use) => {
    // Capture browser console errors so worker diagnostic messages reach
    // the Playwright output (workers post errors via the main thread).
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('[browser]', msg.text());
    });
    // OPFS diagnostic probe: runs on every admin page load to report what
    // storage APIs actually work in this browser/environment.
    // NOTE: addInitScript serialises the function as plain JS — no TS syntax.
    await page.addInitScript(() => {
      if (!location.pathname.startsWith('/admin')) return;
      void (async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ed = (e: any) => `${e?.constructor?.name}: ${e?.message}`;
        const log = (tag: string, ok: boolean, detail = '') =>
          console.error(`[opfs-probe] ${tag}: ${ok ? 'OK' : 'FAIL'} ${detail}`);
        try {
          const root = await navigator.storage.getDirectory();
          log('getDirectory', true);
          try {
            const fh = await root.getFileHandle('.probe-test', { create: true });
            log('getFileHandle', true);
            try {
              const w = await fh.createWritable();
              await w.write('x');
              await w.close();
              await root.removeEntry('.probe-test');
              log('createWritable', true);
            } catch (e) {
              log('createWritable', false, ed(e));
            }
          } catch (e) {
            log('getFileHandle', false, ed(e));
          }
          try {
            await new Promise<void>((res, rej) =>
              navigator.locks
                .request('.probe-lock', () => {
                  res();
                  return Promise.resolve();
                })
                .catch(rej)
            );
            log('locks.request', true);
          } catch (e) {
            log('locks.request', false, ed(e));
          }
        } catch (e) {
          log('getDirectory', false, ed(e));
        }
      })();
    });
    // V8 JS coverage is Chromium (CDP) only. On WebKit / Firefox
    // page.coverage is null; check directly rather than relying on
    // browserName, which may be unreliable under BrowserStack's SDK.
    // page.coverage is non-null on Chromium and on BrowserStack's CDP proxy
    // for WebKit (which exposes the object but fails when called). Wrap the
    // start call so a CDP-level rejection just disables coverage for this test.
    let hasCoverage = page.coverage != null;
    if (hasCoverage) {
      try {
        // CSS coverage skipped: PhotoSwipe + cropperjs ship un-source-
        // mapped CSS that mcr emits warnings for. Add it later if useful.
        await page.coverage.startJSCoverage({ resetOnNavigation: false });
      } catch {
        hasCoverage = false;
      }
    }
    try {
      await use(page);
    } finally {
      if (hasCoverage) {
        const data = await page.coverage.stopJSCoverage();
        // mcr.add rejects empty arrays as invalid; tests like
        // "wrong token does not establish a session" never load any of
        // our bundles so V8 has nothing to record. Skip silently.
        if (data.length > 0) {
          await mcr.add(data);
        }
      }
    }
  }
});

export { expect } from '@playwright/test';
