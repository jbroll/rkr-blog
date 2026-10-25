// E2E coverage for the unified block editor (plan 2026-10-24, Task 7):
// type in place, figure dialog commit, palette drag-drop insert, save,
// reload, and a phone-width smoke check. Seeds through the live blocks
// API (seed-blocks.ts) and uploads one real JPEG so the figure resolves.

import sharp from 'sharp';

import { expect, test } from './coverage-fixtures.ts';
import { makeFixtureMp4, makePng } from './media-fixtures.ts';
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

type Page = import('@playwright/test').Page;
type Upload = { name: string; mimeType: string; buffer: Buffer };

/** Answer the open source picker with local files. */
async function chooseLocal(page: Page, files: Upload[]): Promise<void> {
  const picker = page.locator('#rkr-source-picker');
  await expect(picker).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await picker.getByRole('button', { name: 'From this computer' }).click();
  await (await chooser).setFiles(files);
}

/** Drop a palette primitive just below `target`. */
async function dropBelow(page: Page, label: string, target: import('@playwright/test').Locator) {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  await page
    .locator('.rkr-blocks-palette-item')
    .filter({ has: page.getByText(label, { exact: true }) })
    .dragTo(target, { targetPosition: { x: box!.width / 2, y: box!.height - 5 } });
}

const HEX_INPUT = /^[0-9a-f]{6,64}$/;

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

  // Dropping the Image primitive opens the figure dialog and the picker.
  const dropped = saveResponse(page, slug);
  await dropBelow(page, 'Image', para);
  await dropped;
  const jpeg = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 90, g: 140, b: 200 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  await chooseLocal(page, [{ name: 'marina.jpg', mimeType: 'image/jpeg', buffer: jpeg }]);
  const dialog = page.locator('[data-rkr-dialog]').filter({ hasText: 'Save figure' });
  await expect(dialog.locator('.rkr-media-row')).toHaveCount(1);
  await dialog.getByLabel('Caption').fill('Marina at dusk');
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
    .locator('.rkr-blocks-palette-item')
    .filter({ has: page.getByText('Text', { exact: true }) })
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

test('add image to empty figure via local upload', async ({ page }) => {
  await login(page);
  const slug = `e2e-figure-upload-${Date.now()}`;
  await seedBlockPage(page, { slug, title: 'Figure upload', markdown: 'Above the photos.' });
  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const para = page.locator('#rkr-blocks-page-body p').first();
  await expect(para).toHaveAttribute('contenteditable', 'true');

  const dropped = saveResponse(page, slug);
  await dropBelow(page, 'Image', para);
  await dropped;
  const seed = Date.now();
  await chooseLocal(page, [
    { name: 'one.png', mimeType: 'image/png', buffer: await makePng(seed) },
    { name: 'two.png', mimeType: 'image/png', buffer: await makePng(seed + 1) }
  ]);
  const dialog = page.locator('[data-rkr-dialog]').filter({ hasText: 'Save figure' });
  await expect(dialog.locator('.rkr-media-row')).toHaveCount(2);
  const values = await dialog
    .locator('input')
    .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
  expect(values.filter((v) => HEX_INPUT.test(v))).toEqual([]);

  const committed = saveResponse(page, slug);
  await dialog.getByRole('button', { name: 'Save figure' }).click();
  await committed;
  await page.reload();
  await expect(page.locator('#rkr-blocks-page-body figure img')).toHaveCount(2);
});

test('rotate refreshes the row thumbnail', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  await login(page);
  const slug = `e2e-figure-rotate-${Date.now()}`;
  const imageId = await uploadJpeg(page);
  await seedBlockPage(page, { slug, title: 'Rotate', body: [figureBlock(imageId)] });

  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#rkr-blocks-page-body figure').first().click();
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
  const dialog = page.locator('[data-rkr-dialog]').filter({ hasText: 'Save figure' });
  const thumb = dialog.locator('.rkr-media-row img').first();
  const before = await thumb.getAttribute('src');

  await dialog.getByRole('button', { name: 'Edit image' }).click();
  const editor = page.locator('[data-rkr-dialog] #rkr-image-edit');
  await expect(editor).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#rkr-cell-preview')).toHaveAttribute('src', /^blob:/);
  await expect(page.getByRole('button', { name: 'Back to figure' })).toBeVisible();
  await page.getByRole('button', { name: 'Rotate right' }).click();
  const commit = page.waitForResponse((r) => /\/admin\/sidecar\/[0-9a-f]+\/commit$/.test(r.url()));
  await page.getByRole('button', { name: 'Apply edits' }).click();
  expect((await commit).status()).toBe(200);

  await expect(dialog.locator('.rkr-media-row')).toHaveCount(1);
  await expect(thumb).not.toHaveAttribute('src', before ?? '');
  await expect(page.locator('#rkr-image-edit-host #rkr-image-edit')).toHaveCount(1);
  expect(consoleErrors.filter((m) => /Content Security Policy|decode failed/i.test(m))).toEqual([]);
});

test('add video block', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  const slug = `e2e-video-block-${Date.now()}`;
  await seedBlockPage(page, { slug, title: 'Video block', markdown: 'Watch this.' });
  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const para = page.locator('#rkr-blocks-page-body p').first();
  await expect(para).toHaveAttribute('contenteditable', 'true');

  const dropped = saveResponse(page, slug);
  await dropBelow(page, 'Video', para);
  await dropped;
  await chooseLocal(page, [{ name: 'clip.mp4', mimeType: 'video/mp4', buffer: makeFixtureMp4() }]);
  const dialog = page.locator('[data-rkr-dialog]').filter({ hasText: 'Save video' });
  await expect(dialog.locator('.rkr-media-row')).toHaveCount(1, { timeout: 60_000 });
  const committed = saveResponse(page, slug);
  await dialog.getByRole('button', { name: 'Save video' }).click();
  await committed;
  await page.reload();
  await expect(page.locator('#rkr-blocks-page-body video')).toHaveCount(1);
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

test('macro field edit renders', async ({ page }) => {
  await login(page);
  const slug = `e2e-macro-field-${Date.now()}`;
  await seedBlockPage(page, {
    slug,
    title: 'Macro field',
    body: [{ type: 'macro', macro: 'hero', slots: {} }]
  });

  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const body = page.locator('#rkr-blocks-page-body');
  await expect(body).toContainText('Fresh food, owned by neighbors');
  await body.locator('.rkr-section').click();
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
  await page.getByLabel('Heading').fill('Probe hero heading');
  const saved = saveResponse(page, slug);
  await page.getByLabel('Edit Hero').getByRole('button', { name: 'Save' }).click();
  await saved;

  await expect(body).toContainText('Probe hero heading');
  await expect(body).not.toContainText('Fresh food, owned by neighbors');
  await page.goto(`/${slug}`);
  await expect(page.locator('main')).toContainText('Probe hero heading');
  await expect(page.locator('main')).not.toContainText('Fresh food, owned by neighbors');
});

test('publish a new page', async ({ page }) => {
  await login(page);
  const name = `Spring Sale ${Date.now()}`;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await page.goto('/admin/blocks/new');
  await page.getByLabel('Title').fill(name);
  await expect(page.getByLabel('Slug')).toHaveValue(slug);
  await page.getByRole('button', { name: 'Create and edit' }).click();
  await page.waitForURL(`**/admin/blocks/edit/${slug}`);

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Page settings' }).click();
  const dialog = page.locator('[data-rkr-dialog]').filter({ hasText: 'Page settings' });
  await dialog.getByLabel('Status').selectOption('published');
  await expect(dialog.getByLabel('Publish date')).not.toHaveValue('');
  const saved = saveResponse(page, slug);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await saved;

  await page.context().clearCookies();
  const res = await page.goto(`/${slug}`);
  expect(res?.status()).toBe(200);
  await page.goto('/');
  await expect(page.getByRole('link', { name })).toBeVisible();
});
