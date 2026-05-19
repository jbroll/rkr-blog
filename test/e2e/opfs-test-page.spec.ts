// Headless smoke test for the /_test OPFS harness page.
// Validates that the test runner loads, executes, and reports PASS.
// Level 1 (raw OPFS) always runs; Level 2 (app worker) requires
// a built bundle and is skipped when absent.
//
// Run: npm run test:e2e -- --grep "opfs test page"

import { expect, test } from '@playwright/test';

test('opfs test page: level 1 passes on desktop chromium', async ({ page }) => {
  await page.goto('/_test');

  // Wait for the test runner to finish (leaves "running…" state).
  const st = page.locator('#st');
  await expect(st).not.toContainText('running', { timeout: 30_000 });

  // Level 1 must pass. Level 2 may be SKIP (no bundle) or PASS.
  await expect(st).not.toContainText('FAIL');
  await expect(st).toContainText('PASS');

  // Every visible ✗ would be a failure row — assert none.
  await expect(page.locator('.fail')).toHaveCount(0);
});
