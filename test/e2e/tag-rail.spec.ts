// E2E coverage for the tag rail on the public index:
//   1. No tag PILLS when no published posts have tags (the rail itself
//      is always present — it now also holds the sort + search
//      controls, d4e8de9).
//   2. Tag pills appear after saving a published post with tags.
//   3. Clicking a tag pill filters the list.
//
// Uses POST /admin/posts directly (skips the TipTap editor) to keep
// setup fast, but exercises the full server path: save → reindex → render.

import type { Page } from '@playwright/test';

import { expect, test } from './coverage-fixtures.ts';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

async function loginAndGetPage(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((url: URL) => url.pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
}

test('tag rail: no pills when no published posts have tags', async ({ page }) => {
  await page.goto('/');
  // The rail itself is always rendered (it carries the sort + search
  // controls); only the tag pills are conditional on tagged posts.
  await expect(page.locator('.rkr-tag-rail')).toBeVisible();
  await expect(page.locator('.rkr-tag-rail .rkr-rail-controls')).toBeVisible();
  await expect(page.locator('.rkr-tag-pills')).toHaveCount(0);
  await expect(page.locator('.rkr-tag-pill')).toHaveCount(0);
});

test('tag rail: appears after saving a published post with tags', async ({ page }) => {
  await loginAndGetPage(page);

  // Save a published post with two tags via the API (session cookie sent automatically).
  const res = await page.request.post('/admin/posts', {
    data: {
      title: 'Tag Rail Test Post',
      markdown: 'Hello world.',
      status: 'published',
      tags: ['mountains', 'hiking']
    }
  });
  expect(res.ok()).toBeTruthy();

  await page.goto('/');
  await expect(page.locator('.rkr-tag-rail')).toBeVisible();
  await expect(page.locator('.rkr-tag-rail')).toContainText('mountains');
  await expect(page.locator('.rkr-tag-rail')).toContainText('hiking');
});

test('tag rail: clicking a pill filters the post list', async ({ page }) => {
  await loginAndGetPage(page);

  // Two posts: one tagged 'rivers', one untagged.
  await page.request.post('/admin/posts', {
    data: { title: 'Rivers Post', markdown: 'Water.', status: 'published', tags: ['rivers'] }
  });
  await page.request.post('/admin/posts', {
    data: { title: 'Untagged Post', markdown: 'Dry.', status: 'published' }
  });

  await page.goto('/');
  await page.locator('.rkr-tag-pill', { hasText: 'rivers' }).click();
  await expect(page).toHaveURL(/\?tag=rivers/);
  await expect(page.locator('body')).toContainText('Rivers Post');
  await expect(page.locator('body')).not.toContainText('Untagged Post');
});
