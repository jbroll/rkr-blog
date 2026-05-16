// Playwright globalTeardown: emit the merged coverage report once all
// specs have finished running. Each test's fixture (coverage-
// fixtures.ts) appends raw V8 data to mcr's cache; this hook calls
// generate() to turn that cache into lcov + HTML.

import fs from 'node:fs';
import path from 'node:path';
import { CoverageReport } from 'monocart-coverage-reports';

// Mirrors the resolver in coverage-fixtures.ts. generate() re-reads
// the cache and re-resolves source maps, so the same disk-based
// resolver is needed here even though the server is already stopped.
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

export default async function globalTeardown(): Promise<void> {
  // Mirrors test-e2e/coverage-fixtures.ts. The filter has to be the
  // same here because mcr applies it during generate(); a partial
  // match between fixture-time and teardown-time would emit reports
  // that include the filtered-out files.
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sourcePath: (sp: string, info: { distFile?: string; [key: string]: any }) => {
      const url: string | undefined = info.url;
      if (!url?.startsWith('../') || !info.distFile) return sp;
      const distDir = path.dirname(info.distFile.replace(/^[^/]+\//, ''));
      return path.normalize(path.join(distDir, url));
    }
  });
  // mcr.generate() prints its own console-details report (see
  // reports: ['console-details'] in the fixture); we just need to
  // make sure it runs after the per-test cache is populated.
  await mcr.generate();
}
