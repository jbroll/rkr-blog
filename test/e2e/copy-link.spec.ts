// /:slug copy-link icon button: clicking writes the canonical post
// URL to the clipboard and the button flashes a `data-state="copied"`
// attribute for ~1.5s. Covers src/site/copy-link.ts end-to-end
// (the e2e coverage ratchet keys on this file).

import { expect, test } from './coverage-fixtures.ts';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((url) => new URL(url).pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
}

test('post page: copy-link button writes the URL to the clipboard + flashes copied', async ({
  page,
  context
}) => {
  // The clipboard API only works over HTTPS or on localhost AND when
  // the page is focused; the e2e server is on localhost so we just
  // need to grant the permission and keep the page foregrounded.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await login(page);

  const slug = `e2e-copy-link-${Date.now()}`;
  const res = await page.request.post('/admin/posts', {
    data: { slug, title: 'Hello copy link', status: 'published', markdown: 'body\n' }
  });
  expect(res.status()).toBe(200);

  await page.goto(`/${slug}`);
  const btn = page.locator('.rkr-post-copylink');
  await expect(btn).toBeVisible();

  await btn.click();
  await expect(btn).toHaveAttribute('data-state', 'copied');

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toMatch(new RegExp(`/${slug}$`));

  // The flash clears itself after 1.5s; assert the attribute drops
  // so we know the timer path runs (otherwise the data-state would
  // stick around forever and the colour cue would be wrong on the
  // second click).
  await expect(btn).not.toHaveAttribute('data-state', 'copied', { timeout: 3000 });
});
