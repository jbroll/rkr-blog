// End-to-end coverage for the editor's image flow:
//   1. Insert image  → POST /admin/upload + figure node inserted
//   2. Set matrix    → ::figure attrs panel writes through to the doc
//   3. Save          → POST /admin/posts persists markdown for /:slug
//
// The unit tests cover each route in isolation; this spec exercises the
// browser glue (TipTap insertContent, panel re-population on selection,
// JSON-to-markdown serialization on save) that only runs in a real DOM.

import { expect, test } from '@playwright/test';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

// 1×1 PNG, 67 bytes. Inlined as base64 so the spec doesn't need a fixture
// file and the bytes can survive page.setInputFiles unchanged.
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL('**/admin/editor'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
}

test('editor: insert image, set matrix, save publishes to /:slug', async ({ page }) => {
  await login(page);

  await page.locator('#rkr-title').fill('e2e flow');
  // Unique slug — the e2e site root persists for the run, so reusing one
  // would surface a "already exists" save error.
  const slug = `e2e-flow-${Date.now()}`;
  await page.locator('#rkr-slug').fill(slug);
  await page.locator('#rkr-status').selectOption('published');

  // ---- 1. insert image -------------------------------------------------

  await page.locator('#rkr-image-input').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_BASE64, 'base64')
  });

  // The toolbar's setStatus() trace becomes the visible status line and
  // is the only DOM signal that the upload + insert finished.
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded pixel\.png/, {
    timeout: 10_000
  });

  // The figure node now lives in the editor; the attrs panel reveals
  // itself when the figure is selected (which insertContent does).
  await expect(page.locator('#rkr-figure-attrs')).toBeVisible();
  // The 'ids' field is read-only and populated from the upload result
  // — non-empty here means the round-trip from /admin/upload landed.
  await expect(page.locator('#rkr-figure-ids')).not.toHaveValue('');

  // ---- 2. set matrix ---------------------------------------------------

  await page.locator('#rkr-figure-matrix').fill('1x2');
  // Commit the change — main.ts wires `input` events on text fields. We
  // dispatch one explicitly because Playwright's fill() does it for us,
  // but blur is needed to flush remaining commits in some flows.
  await page.locator('#rkr-figure-matrix').blur();

  // ---- 3. save ---------------------------------------------------------

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(`saved /${slug}`, {
    timeout: 10_000
  });

  // ---- verify the post is reachable on the public site ----------------

  // status=published was selected above, so /:slug renders the post.
  // The figure markdown directive becomes a <figure class="rkr-figure">
  // wrapper; checking for the slug-rendered page + the figure HTML
  // confirms the markdown round-tripped correctly.
  const res = await page.request.get(`/${slug}`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('<title>e2e flow');
  expect(html).toMatch(/class="[^"]*rkr-figure/);
});
