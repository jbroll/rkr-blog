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
// the cached anonymous HTML (no FABs, no Logout). The user had to
// refresh to see the admin chrome. Network-first for / closes this
// gap. To reproduce: visit / anonymously so the SW activates +
// caches /, then run the normal login flow and assert the admin
// chrome appears without a manual reload.
test('login: SW-cached anonymous / does not shadow the admin chrome after login', async ({
  page
}) => {
  await page.goto('/');
  // Wait for the SW to take control of this client so subsequent
  // navigations (/) actually go through cache logic.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(page.getByRole('link', { name: 'New post' })).toHaveCount(0);

  await page.goto('/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((url) => new URL(url).pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
  await expect(page.getByRole('link', { name: 'New post' })).toBeVisible();
});

test('wrong token does not establish a session', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Admin token').fill('wrong-token');
  const responsePromise = page.waitForResponse((r) => r.url().includes('/admin/auth/token-login'));
  await page.getByRole('button', { name: /Sign in with token/ }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(401);
});
