// E2E coverage for saving system posts via the editor's "Save & view".
// These slugs are valid on disk but have no public /:slug page, so the
// client must navigate to their real public URL (or home for the banner)
// instead of the non-existent /_site-banner or /_about page.

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

test('Save on _about points View links at /about', async ({ page }) => {
  await login(page);
  await page.goto('/admin/settings');
  await page.locator('a[href="/admin/about/edit"]').click();
  await expect(page).toHaveURL(/\/admin\/editor\?slug=_about/);
  await expect(page.locator('#rkr-page-title')).toHaveText('Edit post');

  await page.locator('#rkr-title').fill('About the site');
  await expect(page.locator('#rkr-slug')).toHaveValue('_about');

  await page.locator('#rkroll-admin-toolbar button[data-cmd="save"]').click();
  await expect(page.locator('#rkroll-admin-status')).toContainText('saved /_about', {
    timeout: 10_000
  });
  await expect(
    page.locator('#rkroll-admin-status').getByRole('link', { name: 'view →' })
  ).toHaveAttribute('href', '/about');
  await expect(page.locator('#rkr-page-view')).toHaveAttribute('href', '/about');

  await page.locator('#rkroll-admin-toolbar button[data-cmd="save-view"]').click();
  await page.waitForURL((u) => new URL(u).pathname === '/about');
  await expect(page.locator('body')).not.toContainText('Page not found');
});

test('Save on _site-banner points View links at /', async ({ page }) => {
  await login(page);
  await page.goto('/admin/settings');
  await page.locator('a[href="/admin/banner/edit"]').click();
  await expect(page).toHaveURL(/\/admin\/editor\?slug=_site-banner&mode=figure/);
  await expect(page.locator('#rkr-page-title')).toHaveText('Edit post');

  await page.locator('#rkroll-admin-toolbar button[data-cmd="save"]').click();
  await expect(page.locator('#rkroll-admin-status')).toContainText('saved /_site-banner', {
    timeout: 10_000
  });
  await expect(
    page.locator('#rkroll-admin-status').getByRole('link', { name: 'view →' })
  ).toHaveAttribute('href', '/');
  await expect(page.locator('#rkr-page-view')).toHaveAttribute('href', '/');

  await page.locator('#rkroll-admin-toolbar button[data-cmd="save-view"]').click();
  await page.waitForURL((u) => new URL(u).pathname === '/');
  await expect(page.locator('body')).not.toContainText('Page not found');
});
