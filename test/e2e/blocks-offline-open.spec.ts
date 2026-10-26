// The block editor opens offline: the admin service worker serves the
// last online render of the page, and the editor boots edit-capable.

import { expect, test } from './coverage-fixtures.ts';
import { seedBlockPage } from './seed-blocks.ts';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

type Page = import('@playwright/test').Page;

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((url: URL) => url.pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
}

/** Text of the cached render of the current page, or null. */
function cachedPage(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const hit = await caches.match(location.pathname, { ignoreSearch: true });
    return hit ? hit.text() : null;
  });
}

test('a previously opened page loads offline, edit-capable, with its last saved content', async ({
  page,
  context
}) => {
  await login(page);
  const slug = `e2e-offline-open-${Date.now()}`;
  await seedBlockPage(page, { slug, title: 'Offline open', markdown: 'Loaded online.' });

  await page.goto('/admin/blocks');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  await page.goto(`/admin/blocks/edit/${slug}`);
  await expect.poll(() => cachedPage(page)).toContain('Loaded online.');

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const para = page.locator('#rkr-blocks-page-body p').first();
  await expect(para).toHaveAttribute('contenteditable', 'true');
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(`/admin/blocks/${slug}`) && r.request().method() === 'POST'
  );
  await para.click();
  await para.fill('Saved online.');
  await page.keyboard.press('Tab');
  expect((await saved).status()).toBe(200);
  // A save re-caches the page, so the offline copy is not the pre-save one.
  await expect.poll(() => cachedPage(page)).toContain('Saved online.');

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#rkr-blocks-page-body p').first()).toHaveText('Saved online.');
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const offlinePara = page.locator('#rkr-blocks-page-body p').first();
  await expect(offlinePara).toHaveAttribute('contenteditable', 'true');
  await offlinePara.click();
  await offlinePara.fill('Edited offline.');
  await page.keyboard.press('Tab');
  await expect(page.locator('.rkr-unified-save-state')).toHaveText('Offline, will sync');

  await context.setOffline(false);
});

test('leaving right after a save still re-caches the saved page', async ({ page }) => {
  await login(page);
  const slug = `e2e-offline-leave-${Date.now()}`;
  await seedBlockPage(page, { slug, title: 'Leave fast', markdown: 'Before the save.' });

  await page.goto('/admin/blocks');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const para = page.locator('#rkr-blocks-page-body p').first();
  await expect(para).toHaveAttribute('contenteditable', 'true');
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(`/admin/blocks/${slug}`) && r.request().method() === 'POST'
  );
  await para.click();
  await para.fill('Saved, then left.');
  await page.keyboard.press('Tab');
  expect((await saved).status()).toBe(200);
  await page.goto('/admin/blocks');

  await expect
    .poll(() =>
      page.evaluate(async (path) => {
        const hit = await caches.match(path, { ignoreSearch: true });
        return hit ? hit.text() : null;
      }, `/admin/blocks/edit/${slug}`)
    )
    .toContain('Saved, then left.');
});

test('signing out drops the cached editor pages and the editor drafts', async ({ page }) => {
  await login(page);
  const slug = `e2e-signout-${Date.now()}`;
  await seedBlockPage(page, { slug, title: 'Sign out', markdown: 'Cached page.' });
  await page.goto('/admin/blocks');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.goto(`/admin/blocks/edit/${slug}`);
  await expect.poll(() => cachedPage(page)).toContain('Cached page.');
  const hasDrafts = () =>
    page.evaluate(async () =>
      (await indexedDB.databases()).map((d) => d.name).includes('rkr-blocks-editor')
    );
  await expect.poll(hasDrafts).toBe(true);

  await page.goto('/');
  await Promise.all([
    page.waitForURL((url: URL) => url.pathname === '/'),
    page.getByRole('button', { name: 'Logout' }).click()
  ]);
  await expect
    .poll(() =>
      page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('rkr-admin-')))
    )
    .toEqual([]);
  await expect.poll(hasDrafts).toBe(false);
});
