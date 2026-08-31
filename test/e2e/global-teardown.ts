// Playwright globalTeardown: emit the merged coverage report once all
// specs have finished running. Each test's fixture (coverage-
// fixtures.ts) appends raw V8 data to mcr's cache; this hook calls
// generate() to turn that cache into lcov + HTML.

import { CoverageReport } from 'monocart-coverage-reports';
import { coverageOptions } from './coverage-config.ts';

export default async function globalTeardown(): Promise<void> {
  // mcr.generate() prints its own console-details report (see
  // reports: ['console-details'] in coverage-config.ts); we just need
  // to make sure it runs after the per-test cache is populated.
  await new CoverageReport(coverageOptions).generate();
}
