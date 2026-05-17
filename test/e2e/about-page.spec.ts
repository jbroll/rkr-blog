// E2E coverage for the About page feature:
//   1. Header nav: Home link omitted on the home page (it links to
//      itself), present on non-home pages; About / Login always shown
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

test('header nav: Home omitted on /, present off-home; About/Login always; /about 404s before seed', async ({
  page
}) => {
  // Home page: self-referential Home link is intentionally omitted
  // (8d4cd5b). About + Login remain.
  await page.goto('/');
  const homeNav = page.locator('.rkr-site-head-nav');
  await expect(homeNav.getByRole('link', { name: 'Home' })).toHaveCount(0);
  await expect(homeNav.getByRole('link', { name: 'About' })).toHaveAttribute('href', '/about');
  await expect(homeNav.getByRole('link', { name: 'Login' })).toBeVisible();

  // /about 404s before the _about post is seeded; the 404 page is a
  // non-home page, so its nav DOES carry the Home link.
  const r = await page.request.get('/about');
  expect(r.status()).toBe(404);

  await page.goto('/about');
  const offHomeNav = page.locator('.rkr-site-head-nav');
  await expect(offHomeNav.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
  await expect(offHomeNav.getByRole('link', { name: 'About' })).toHaveAttribute('href', '/about');
  await expect(offHomeNav.getByRole('link', { name: 'Login' })).toBeVisible();
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
