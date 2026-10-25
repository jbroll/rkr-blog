// E2E coverage for the unified block editor (plan 2026-10-24, Task 7):
// type in place, figure dialog commit, palette drag-drop insert, save,
// reload, and a phone-width smoke check. Seeds through the live blocks
// API (seed-blocks.ts) and uploads one real JPEG so the figure resolves.

import sharp from 'sharp';

import { expect, test } from './coverage-fixtures.ts';
import { figureBlock, seedBlockPage } from './seed-blocks.ts';

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

/** The page save, not the render preview that precedes it. */
function saveResponse(page: import('@playwright/test').Page, slug: string) {
  return page.waitForResponse(
    (r) => r.url().endsWith(`/admin/blocks/${slug}`) && r.request().method() === 'POST'
  );
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
  const typed = saveResponse(page, slug);
  await page.keyboard.press('Tab');
  await typed;

  // Drag the Image primitive below the text leaf. The page re-renders in
  // place, so edit mode stays active and the empty figure is visible.
  const box = await para.boundingBox();
  expect(box).not.toBeNull();
  const paletteImage = page.locator('.rkr-blocks-palette-item', { hasText: 'Image' });
  const dropped = saveResponse(page, slug);
  await paletteImage.dragTo(para, {
    targetPosition: { x: box!.width / 2, y: box!.height - 5 }
  });
  await dropped;
  await expect(page.locator('.rkr-unified-empty')).toBeVisible();
  const figureConfig = page.getByRole('button', { name: 'Configure', exact: true });
  await expect(figureConfig).toBeVisible();

  // Figure dialog: real image id + caption, then save.
  await figureConfig.click();
  const dialog = page.locator('.rkr-figure-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('input').first().fill(imageId);
  await dialog.locator('input').nth(2).fill('Marina at dusk');
  const committed = saveResponse(page, slug);
  await dialog.getByRole('button', { name: 'Save figure' }).click();
  await committed;

  // Public page shows the typed text and the captioned figure.
  await page.goto(`/${slug}`);
  await expect(page.locator('article')).toContainText('Hello unified edited.');
  await expect(page.locator('article')).toContainText('Marina at dusk');
});

async function dragTextAbove(
  page: import('@playwright/test').Page,
  target: import('@playwright/test').Locator
): Promise<void> {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await page
    .locator('.rkr-blocks-palette-item', { hasText: 'Text' })
    .dragTo(target, { targetPosition: { x: box!.width / 2, y: 2 } });
}

test('edit after insert writes the right block', async ({ page }) => {
  await login(page);
  const slug = `e2e-insert-edit-${Date.now()}`;
  await seedBlockPage(page, { slug, title: 'Insert edit', markdown: 'Welcome aboard.' });

  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const first = page.locator('#rkr-blocks-page-body p').first();
  await expect(first).toHaveAttribute('contenteditable', 'true');

  const inserted = saveResponse(page, slug);
  await dragTextAbove(page, first);
  await inserted;
  await expect(page.locator('#rkr-blocks-page-body [data-rkr-blank]')).toHaveCount(1);

  const original = page.locator('#rkr-blocks-page-body p[data-rkr-path="1"]');
  await expect(original).toHaveText('Welcome aboard.');
  await original.click();
  await original.fill('Welcome aboard, edited.');
  const edited = saveResponse(page, slug);
  await page.keyboard.press('Tab');
  await edited;

  await page.reload();
  const res = await page.request.get(`/admin/blocks/${slug}`);
  const { tree } = (await res.json()) as { tree: { body: { type: string; markdown?: string }[] } };
  expect(tree.body).toEqual([
    { type: 'text', markdown: '' },
    { type: 'text', markdown: 'Welcome aboard, edited.' }
  ]);
  const text = (await page.locator('#rkr-blocks-page-body').textContent()) ?? '';
  expect(text.match(/Welcome/g)?.length).toBe(1);
});

test('insert does not reload', async ({ page }) => {
  await login(page);
  const slug = `e2e-insert-noreload-${Date.now()}`;
  await seedBlockPage(page, { slug, title: 'No reload', markdown: 'Stay put.' });

  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.evaluate(() => {
    (window as unknown as { __marker?: number }).__marker = 1;
  });

  const inserted = saveResponse(page, slug);
  await dragTextAbove(page, page.locator('#rkr-blocks-page-body p').first());
  await inserted;
  await expect(page.locator('#rkr-blocks-page-body [data-rkr-blank]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
});

test('figure dialog hosts the image-edit pipeline with a blob preview', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  await login(page);
  const slug = `e2e-figure-preview-${Date.now()}`;
  const imageId = await uploadJpeg(page);
  await seedBlockPage(page, {
    slug,
    title: 'Figure preview',
    body: [figureBlock(imageId)],
    status: 'published'
  });

  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#rkr-blocks-page-body figure').first().click();
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
  const dialog = page.locator('.rkr-figure-dialog');
  await expect(dialog).toBeVisible();
  // The section is moved, not cloned: exactly one node, inside the dialog.
  await expect(page.locator('#rkr-image-edit')).toHaveCount(1);
  await expect(dialog.locator('#rkr-image-edit')).toHaveCount(1);

  // Selecting the image moves the (formerly hidden-hosted) pipeline
  // into the dialog and paints the canvas result as a blob: preview.
  const thumb = dialog.locator('.rkr-figure-image-thumb').first();
  await thumb.click();
  await expect(thumb).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.locator('.rkr-figure-image-thumb.is-active')).toHaveCount(1);
  await expect(dialog.locator('#rkr-image-edit')).toBeVisible();
  const preview = dialog.locator('#rkr-cell-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute('src', /^blob:/);

  expect(
    consoleErrors.filter(
      (m) => /decode failed/i.test(m) || (/Content Security Policy/i.test(m) && /blob:/i.test(m))
    )
  ).toEqual([]);

  // Closing returns the section to its stash so a reopen starts clean.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#rkr-image-edit-host #rkr-image-edit')).toHaveCount(1);
  await expect(page.locator('#rkr-image-edit')).toBeHidden();

  // Escape is the other cancel path; it must restore the same stash.
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
  await expect(page.locator('.rkr-figure-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.rkr-figure-dialog')).toHaveCount(0);
  await expect(page.locator('#rkr-image-edit-host #rkr-image-edit')).toHaveCount(1);
  await expect(page.locator('#rkr-image-edit')).toBeHidden();
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

test('delete an empty text block', async ({ page }) => {
  await login(page);
  const slug = `e2e-delete-empty-${Date.now()}`;
  await seedBlockPage(page, { slug, title: 'Delete empty', markdown: 'Keep me.' });

  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const inserted = saveResponse(page, slug);
  await dragTextAbove(page, page.locator('#rkr-blocks-page-body p').first());
  await inserted;
  const blank = page.locator('#rkr-blocks-page-body [data-rkr-blank]');
  await expect(blank).toHaveCount(1);

  await page.locator('#rkr-blocks-page-body p[data-rkr-path="1"]').click();
  await blank.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar', { name: 'Block actions' })).toBeVisible();

  const deleted = saveResponse(page, slug);
  await page.keyboard.press('Delete');
  await deleted;
  await expect(blank).toHaveCount(0);

  await page.reload();
  const res = await page.request.get(`/admin/blocks/${slug}`);
  const { tree } = (await res.json()) as { tree: { body: { markdown?: string }[] } };
  expect(tree.body).toEqual([{ type: 'text', markdown: 'Keep me.' }]);
});

test('drag an existing figure below the row', async ({ page }) => {
  await login(page);
  const slug = `e2e-drag-figure-${Date.now()}`;
  const imageId = await uploadJpeg(page);
  await seedBlockPage(page, {
    slug,
    title: 'Drag figure',
    body: [
      figureBlock(imageId),
      { type: 'row', children: [{ type: 'text', markdown: 'Inside the row.' }] }
    ]
  });

  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#rkr-blocks-page-body figure').first().click();
  const handle = page.getByRole('button', { name: 'Drag to move' });
  await expect(handle).toBeVisible();

  const row = page.locator('#rkr-blocks-page-body .rkr-row');
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  const moved = saveResponse(page, slug);
  await handle.dragTo(row, { targetPosition: { x: 4, y: box!.height - 3 } });
  await moved;

  await page.reload();
  const res = await page.request.get(`/admin/blocks/${slug}`);
  const { tree } = (await res.json()) as { tree: { body: { type: string }[] } };
  expect(tree.body.map((n) => n.type)).toEqual(['row', 'figure']);
});
