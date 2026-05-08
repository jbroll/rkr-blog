// Smoke test for the admin token-login flow. Exercises the full path
// shipped in 53b3543:
//   GET  /admin/login                  → form renders
//   POST /admin/auth/token-login       → session cookie + redirect
//   GET  /admin/editor (with cookie)   → SPA shell renders

import { expect, test } from '@playwright/test';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

test('login page renders both Google and token options', async ({ page }) => {
  await page.goto('/admin/login');
  await expect(page).toHaveTitle(/Sign in/);
  await expect(page.getByRole('link', { name: /Sign in with Google/ })).toBeVisible();
  await expect(page.getByLabel('Admin token')).toBeVisible();
  await expect(page.getByRole('button', { name: /Sign in with token/ })).toBeVisible();
});

test('token-login establishes a session and reaches /admin/editor', async ({ page }) => {
  await page.goto('/admin/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL('**/admin/editor'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
  // The editor SPA shell mount point is asserted by the unit test suite;
  // here we just confirm we landed and the page rendered.
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
});

test('wrong token does not establish a session', async ({ page }) => {
  await page.goto('/admin/login');
  await page.getByLabel('Admin token').fill('wrong-token');
  const responsePromise = page.waitForResponse((r) => r.url().includes('/admin/auth/token-login'));
  await page.getByRole('button', { name: /Sign in with token/ }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(401);
});
