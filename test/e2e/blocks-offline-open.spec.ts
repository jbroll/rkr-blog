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

/** Store a draft for `slug` the way the editor does, with a body the server lacks. */
function putDraft(page: Page, slug: string): Promise<void> {
  return page.evaluate(
    (key) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('rkr-blocks-editor', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('drafts');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction('drafts', 'readwrite');
          tx.objectStore('drafts').put(
            {
              tree: {
                version: 1,
                body: [{ type: 'text', markdown: 'Never sent.' }],
                fields: { title: 'Unsent page', slug: key }
              },
              baseVersion: 'stale',
              savedAt: Date.now()
            },
            key
          );
          tx.oncomplete = () => {
            req.result.close();
            resolve();
          };
        };
      }),
    slug
  );
}

function draftSlugs(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const req = indexedDB.open('rkr-blocks-editor', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('drafts');
        req.onsuccess = () => {
          const keys = req.result.transaction('drafts').objectStore('drafts').getAllKeys();
          keys.onsuccess = () => {
            req.result.close();
            resolve(keys.result.map(String));
          };
        };
      })
  );
}

async function openEditorOnce(page: Page, slug: string): Promise<void> {
  await seedBlockPage(page, { slug, title: 'Sign out', markdown: 'Cached page.' });
  await page.goto('/admin/blocks');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.goto(`/admin/blocks/edit/${slug}`);
  await expect.poll(() => cachedPage(page)).toContain('Cached page.');
}

test('the logout landing drops cached editor pages but keeps drafts', async ({ page }) => {
  await login(page);
  const slug = `e2e-landing-${Date.now()}`;
  await openEditorOnce(page, slug);
  await putDraft(page, slug);

  await page.goto('/?_rkr=logout');
  await expect
    .poll(() =>
      page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('rkr-admin-')))
    )
    .toEqual([]);
  expect(await draftSlugs(page)).toContain(slug);
});

test('signing out with an unsynced draft asks before deleting it', async ({ page }) => {
  await login(page);
  const slug = `e2e-signout-${Date.now()}`;
  await openEditorOnce(page, slug);
  await putDraft(page, slug);
  await page.goto('/');

  await page.getByRole('button', { name: 'Logout' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(
    '1 page has changes that never reached the server. Signing out deletes them.'
  );
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();
  expect(await draftSlugs(page)).toContain(slug);

  await page.getByRole('button', { name: 'Logout' }).click();
  await Promise.all([
    page.waitForURL((url: URL) => url.pathname === '/' && !url.search.includes('_rkr')),
    page.getByRole('dialog').getByRole('button', { name: 'Sign out and delete' }).click()
  ]);
  await expect(page.getByRole('link', { name: 'Login' })).toBeVisible();
  expect(await draftSlugs(page)).not.toContain(slug);
});
