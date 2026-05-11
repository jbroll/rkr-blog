// Smoke test for the admin token-login flow:
//   GET  /admin/login                  → form renders
//   POST /admin/auth/token-login       → session cookie + redirect to /
//   GET  /              (with cookie)  → public index + admin strip

import { expect, test } from './coverage-fixtures.ts';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

test('login page renders both Google and token options', async ({ page }) => {
  await page.goto('/admin/login');
  await expect(page).toHaveTitle(/Sign in/);
  await expect(page.getByRole('link', { name: /Sign in with Google/ })).toBeVisible();
  await expect(page.getByLabel('Admin token')).toBeVisible();
  await expect(page.getByRole('button', { name: /Sign in with token/ })).toBeVisible();
});

test('token-login establishes a session and lands on the public index with admin strip', async ({
  page
}) => {
  await page.goto('/admin/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((url) => new URL(url).pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
  // Admin chrome surfaces the entry points to the editor.
  await expect(page.getByRole('link', { name: 'New post' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
});

test('wrong token does not establish a session', async ({ page }) => {
  await page.goto('/admin/login');
  await page.getByLabel('Admin token').fill('wrong-token');
  const responsePromise = page.waitForResponse((r) => r.url().includes('/admin/auth/token-login'));
  await page.getByRole('button', { name: /Sign in with token/ }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(401);
});
