// E2E coverage for the unified block editor (plan 2026-10-24, Task 7):
// type in place, figure dialog commit, palette drag-drop insert, save,
// reload, and a phone-width smoke check. Seeds through the live blocks
// API (seed-blocks.ts) and uploads one real JPEG so the figure resolves.

import sharp from 'sharp';

import { expect, test } from './coverage-fixtures.ts';
import { seedBlockPage } from './seed-blocks.ts';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((url: URL) => url.pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
}

async function uploadJpeg(page: import('@playwright/test').Page): Promise<string> {
  const buf = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 90, g: 140, b: 200 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  const res = await page.request.post('/admin/upload', {
    multipart: { file: { name: 'unified-e2e.jpg', mimeType: 'image/jpeg', buffer: buf } }
  });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

test('unified flow: type, figure dialog, palette drop, save, reload', async ({ page }) => {
  await login(page);
  const slug = `e2e-unified-${Date.now()}`;
  await seedBlockPage(page, {
    slug,
    title: 'Unified E2E',
    markdown: 'Hello unified.',
    status: 'published'
  });
  const imageId = await uploadJpeg(page);

  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const para = page.locator('#rkr-blocks-page-body p').first();
  await expect(para).toHaveAttribute('contenteditable', 'true');

  // Type in place; blur saves.
  await para.click();
  await para.fill('Hello unified edited.');
  await page.keyboard.press('Tab');
  await page.waitForResponse(
    (r) => r.url().includes('/admin/blocks/') && r.request().method() === 'POST'
  );

  // Drag the Image primitive below the text leaf. The drop inserts a
  // placeholder in place (no reload) so the dropped item stays visible
  // and edit mode is preserved.
  const box = await para.boundingBox();
  expect(box).not.toBeNull();
  const paletteImage = page.locator('.rkr-blocks-palette-item', { hasText: 'Image' });
  await paletteImage.dragTo(para, {
    targetPosition: { x: box!.width / 2, y: box!.height - 5 }
  });
  await page.waitForResponse(
    (r) => r.url().includes('/admin/blocks/') && r.request().method() === 'POST'
  );
  // No reload: edit mode stays active and the dropped figure placeholder
  // is visible without re-entering edit.
  await expect(page.locator('.rkr-unified-empty')).toBeVisible();
  const figureConfig = page.getByRole('button', { name: 'Configure figure' });
  await expect(figureConfig).toBeVisible();

  // Figure dialog: real image id + caption, then save.
  await figureConfig.click();
  const dialog = page.locator('.rkr-figure-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('input').first().fill(imageId);
  await dialog.locator('input').nth(2).fill('Marina at dusk');
  await dialog.getByRole('button', { name: 'Save figure' }).click();
  await page.waitForResponse(
    (r) => r.url().includes('/admin/blocks/') && r.request().method() === 'POST'
  );

  // Public page shows the typed text and the captioned figure.
  await page.goto(`/${slug}`);
  await expect(page.locator('article')).toContainText('Hello unified edited.');
  await expect(page.locator('article')).toContainText('Marina at dusk');
});

test('unified edit page has no horizontal overflow at phone width', async ({ page }) => {
  await login(page);
  const slug = `e2e-unified-phone-${Date.now()}`;
  await seedBlockPage(page, {
    slug,
    title: 'Phone Width',
    markdown: 'Narrow.',
    status: 'published'
  });
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
