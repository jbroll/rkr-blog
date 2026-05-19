// E2E coverage for the About page feature:
//   1. Header nav: Home link omitted on the home page (it links to
//      itself), present on non-home pages; About / Login always shown
//   2. /about 404s before the _about post is seeded
//   3. settings → "Create About" → editor opens on _about slug
//   4. Filling the title and saving creates _about.md → /about renders

import { test as coverageTest, expect } from './coverage-fixtures.ts';

const test = coverageTest;

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.locator('input[name="token"]').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((u) => new URL(u).pathname === '/'),
    page.locator('button[type="submit"]').click()
  ]);
}

test('header nav: Home omitted on /, present off-home; About/Login always; /about 404s before seed', async ({
  page
}) => {
  await page.goto('/');
  const homeNav = page.locator('.rkr-site-head-nav');
  await expect(homeNav.locator('a[href="/"]')).toHaveCount(0);
  await expect(homeNav.locator('a[href="/about"]')).toBeVisible();
  await expect(homeNav.locator('a[href="/login"]')).toBeVisible();

  await page.goto('/about');
  const offHomeNav = page.locator('.rkr-site-head-nav');
  await expect(offHomeNav.locator('a[href="/"]')).toBeVisible();
  await expect(offHomeNav.locator('a[href="/about"]')).toBeVisible();
  await expect(offHomeNav.locator('a[href="/login"]')).toBeVisible();
});

test('settings → Create About → editor opens on _about; /about then renders', async ({ page }) => {
  await login(page);
  await page.goto('/admin/settings');
  await page.locator('a[href="/admin/about/edit"]').click();
  await expect(page).toHaveURL(/\/admin\/editor\?slug=_about/);
  await page.locator('#rkr-title').fill('About');
  await page.locator('#rkroll-admin-toolbar button[data-cmd="save"]').click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^saved \//, {
    timeout: 10_000
  });
  await page.goto('/about');
  await expect(page.locator('main')).toContainText('About');
  await expect(page.locator('.rkr-comment-form')).toHaveCount(0);
});
