// Playwright fixtures that capture V8 JS+CSS coverage per test and
// hand the raw data to monocart-coverage-reports (mcr). mcr resolves
// source maps to map the coverage from bundled URLs (e.g.
// /static/admin/main.js) back to source files (src/admin/main.ts).
//
// Per-process state: ONE mcr instance shared across all tests in a
// worker. Each test fixture runs add() with that test's data; mcr
// caches the entries to disk. global-teardown.ts calls generate()
// once at the end of the run to emit lcov + HTML reports.

import fs from 'node:fs';
import path from 'node:path';
import { test as baseTest } from '@playwright/test';
import { CoverageReport } from 'monocart-coverage-reports';

// Read source maps directly from disk instead of fetching via HTTP.
// The default resolver issues HTTP GETs to the running test server;
// in global-teardown the server is already stopped, and during tests
// the version query string on main.js and site bundles may confuse
// URL matching. Disk reads are reliable in both phases.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sourceMapResolver = async (url: string, defaultResolver: any): Promise<unknown> => {
  const match = url.match(/\/(static\/(?:admin|site)\/.+\.map)$/);
  if (match) {
    const localPath = path.join(process.cwd(), match[1]!);
    if (fs.existsSync(localPath)) {
      return JSON.parse(fs.readFileSync(localPath, 'utf8')) as unknown;
    }
  }
  return defaultResolver(url);
};

// Single mcr per worker process. resetOnNavigation:false on the
// page.coverage calls means we keep accumulating across navigations
// within one test (login → editor → save → /:slug all count).
// Source filtering: keep only OUR code. Without this the report
// includes node_modules (TipTap, ProseMirror, PhotoSwipe).
// entryFilter narrows the V8 entries (bundle URLs); sourceFilter
// narrows source paths after sourcemap unpacking. src/lib/ files
// imported into the admin/site bundle are tracked too — server-only
// lib files (db.ts, migrate.ts, etc.) never reach the bundle so the
// V8 data won't include them.
const mcr = new CoverageReport({
  name: 'rkroll e2e (admin SPA + public site)',
  outputDir: './coverage/e2e',
  reports: ['v8', 'lcovonly', 'console-details'],
  entryFilter: (entry: { url: string }) =>
    entry.url.includes('/static/admin/') || entry.url.includes('/static/site/'),
  sourceFilter: (sourcePath: string) =>
    sourcePath.includes('src/admin/') ||
    sourcePath.includes('src/site/') ||
    sourcePath.includes('src/lib/'),
  sourceMapResolver,
  // esbuild stores source paths relative to the bundle (e.g.
  // '../../src/admin/toast.ts' relative to static/admin/main.js).
  // monocart resolves these from process.cwd(), producing '../admin/toast.ts'
  // which fails the sourceFilter. Re-resolve against the dist dir instead.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sourcePath: (sp: string, info: { distFile?: string; [key: string]: any }) => {
    const url: string | undefined = info.url;
    if (!url?.startsWith('../') || !info.distFile) return sp;
    const distDir = path.dirname(info.distFile.replace(/^[^/]+\//, ''));
    return path.normalize(path.join(distDir, url));
  },
  // Defer cache cleanup to global-teardown so the cache persists
  // across spec files (Playwright runs each .spec.ts in a fresh test
  // process when configured to fork; we use workers:1 today, but
  // append-only cache is correct under either).
  cleanCache: false
});

export const test = baseTest.extend({
  page: async ({ page, browserName }, use) => {
    // V8 JS coverage is Chromium (CDP) only. On WebKit / Firefox
    // the page.coverage API is absent; skip collection silently so
    // the same spec files can run on Safari without modification.
    const hasCoverage = browserName === 'chromium';
    // CSS coverage skipped: PhotoSwipe + cropperjs ship un-source-
    // mapped CSS that mcr emits warnings for. Add it later if useful.
    if (hasCoverage) await page.coverage.startJSCoverage({ resetOnNavigation: false });
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
