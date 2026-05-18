// Smoke test for the admin token-login flow:
//   GET  /login                        → form renders
//   POST /admin/auth/token-login       → session cookie + redirect to /
//   GET  /              (with cookie)  → public index + admin strip

import { expect, test } from './coverage-fixtures.ts';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

test('login page renders both Google and token options', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveTitle(/Sign in/);
  await expect(page.getByRole('link', { name: /Sign in with Google/ })).toBeVisible();
  await expect(page.getByLabel('Admin token')).toBeVisible();
  await expect(page.getByRole('button', { name: /Sign in with token/ })).toBeVisible();
});

test('token-login establishes a session and lands on the public index with admin strip', async ({
  page
}) => {
  await page.goto('/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((url) => new URL(url).pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
  // Admin chrome surfaces the entry points to the editor.
  await expect(page.getByRole('link', { name: 'New post' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
});

// Regression: the public service worker used to serve stale-while-
// revalidate for /, so after logging in the redirect target returned
// the cached anonymous HTML (no FABs, no Logout). Anon pages now run
// sw-unregister.js (no SW registration), so the cached-anon-page
// scenario is structurally impossible. Test remains to guard the
// login-from-anon flow.
test('login: anon visit followed by login shows admin chrome without reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'New post' })).toHaveCount(0);

  await page.goto('/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((url) => new URL(url).pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
  await expect(page.getByRole('link', { name: 'New post' })).toBeVisible();
});

test('logout: sw-unregister strips ?_rkr param so URL bar stays clean', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((url) => new URL(url).pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();

  await page.getByRole('button', { name: 'Logout' }).click();
  // Logout redirects to /?_rkr=logout; sw-unregister.js strips the param
  // via history.replaceState. waitForURL doesn't detect replaceState, so
  // poll via waitForFunction instead.
  await page.waitForFunction(() => !location.search.includes('_rkr'));
  expect(page.url()).not.toContain('_rkr');
  await expect(page.getByRole('link', { name: 'New post' })).toHaveCount(0);
});

test('wrong token does not establish a session', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Admin token').fill('wrong-token');
  const responsePromise = page.waitForResponse((r) => r.url().includes('/admin/auth/token-login'));
  await page.getByRole('button', { name: /Sign in with token/ }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(401);
});
