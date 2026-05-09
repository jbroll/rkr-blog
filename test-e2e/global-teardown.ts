// Playwright globalTeardown: emit the merged coverage report once all
// specs have finished running. Each test's fixture (coverage-
// fixtures.ts) appends raw V8 data to mcr's cache; this hook calls
// generate() to turn that cache into lcov + HTML.

import { CoverageReport } from 'monocart-coverage-reports';

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
      sourcePath.includes('src/admin/') || sourcePath.includes('src/site/')
  });
  // mcr.generate() prints its own console-details report (see
  // reports: ['console-details'] in the fixture); we just need to
  // make sure it runs after the per-test cache is populated.
  await mcr.generate();
}
