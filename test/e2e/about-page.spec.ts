// E2E coverage for the About page feature:
//   1. Header nav shows Home / About / Login for anonymous users
//   2. /about 404s before the _about post is seeded
//   3. settings → "Create About" → editor opens on _about slug
//   4. Filling the title and saving creates _about.md → /about renders

import { expect, test } from './coverage-fixtures.ts';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((u) => new URL(u).pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
}

test('header nav: anonymous sees Home/About/Login; /about 404s before seed', async ({ page }) => {
  await page.goto('/');
  const nav = page.locator('.rkr-site-head-nav');
  await expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
  await expect(nav.getByRole('link', { name: 'About' })).toHaveAttribute('href', '/about');
  await expect(nav.getByRole('link', { name: 'Login' })).toBeVisible();
  const r = await page.request.get('/about');
  expect(r.status()).toBe(404);
});

test('settings → Create About → editor opens on _about; /about then renders', async ({ page }) => {
  await login(page);
  await page.goto('/admin/settings');
  await page.getByRole('link', { name: /Create About|Edit About/ }).click();
  await expect(page).toHaveURL(/\/admin\/editor\?slug=_about/);
  await page.locator('#rkr-title').fill('About');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^saved \//, {
    timeout: 10_000
  });
  await page.goto('/about');
  await expect(page.locator('main')).toContainText('About');
  await expect(page.locator('.rkr-comment-form')).toHaveCount(0);
});
