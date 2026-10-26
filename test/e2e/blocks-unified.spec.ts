// E2E coverage for the unified block editor: the full author flow, type in
// place, figure dialog, palette insert, save, reload, offline and phone
// width. Seeds through the live blocks API (seed-blocks.ts).

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

const paletteItem = (page: Page, label: string) =>
  page.locator('.rkr-blocks-palette-item').filter({ has: page.getByText(label, { exact: true }) });

const HEX_INPUT = /^[0-9a-f]{6,64}$/;

/** The page save, not the render preview that precedes it. */
function saveResponse(page: import('@playwright/test').Page, slug: string) {
  return page.waitForResponse(
    (r) => r.url().endsWith(`/admin/blocks/${slug}`) && r.request().method() === 'POST'
  );
}

test('unified flow: new page, type, image, hero, publish, reload, public', async ({
  page,
  browser
}) => {
  await login(page);
  const name = `Full Flow ${Date.now()}`;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await page.goto('/admin/blocks/new');
  await page.getByLabel('Title').fill(name);
  await page.getByRole('button', { name: 'Create and edit' }).click();
  await page.waitForURL(`**/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();

  // Insert a text block from the palette, then type in place; blur saves.
  const body = page.locator('#rkr-blocks-page-body');
  const inserted = saveResponse(page, slug);
  await paletteItem(page, 'Text').focus();
  await page.keyboard.press('Enter');
  await inserted;
  const para = body.locator('[data-rkr-blank]').first();
  await para.click();
  await para.fill('Hello full flow.');
  const typed = saveResponse(page, slug);
  await page.keyboard.press('Tab');
  await typed;

  // Image primitive: pick a local file, caption it, commit.
  await dropBelow(page, 'Image', body.locator('p').first());
  const jpeg = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 90, g: 140, b: 200 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  await chooseLocal(page, [{ name: 'marina.jpg', mimeType: 'image/jpeg', buffer: jpeg }]);
  const figureDialog = page.locator('[data-rkr-dialog]').filter({ hasText: 'Save figure' });
  await expect(figureDialog.locator('.rkr-media-row')).toHaveCount(1);
  await figureDialog.getByLabel('Caption').fill('Marina at dusk');
  const committed = saveResponse(page, slug);
  await figureDialog.getByRole('button', { name: 'Save figure' }).click();
  await committed;

  // Hero macro from the palette, with its heading overridden.
  const heroInserted = saveResponse(page, slug);
  await dropBelow(page, 'Hero', body.locator('p').first());
  await heroInserted;
  await expect(body).toContainText('Fresh food, owned by neighbors');
  await body.locator('.rkr-section').click();
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
  await page.getByLabel('Heading').fill('Full flow hero');
  const heroSaved = saveResponse(page, slug);
  await page.getByLabel('Edit Hero').getByRole('button', { name: 'Save' }).click();
  await heroSaved;

  // Publish through page settings.
  await page.getByRole('button', { name: 'Page settings' }).click();
  const settings = page.locator('[data-rkr-dialog]').filter({ hasText: 'Page settings' });
  await settings.getByLabel('Status').selectOption('published');
  const published = saveResponse(page, slug);
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await published;

  // Reload keeps everything.
  await page.reload();
  const reloaded = page.locator('#rkr-blocks-page-body');
  await expect(reloaded).toContainText('Hello full flow.');
  await expect(reloaded).toContainText('Marina at dusk');
  await expect(reloaded).toContainText('Full flow hero');

  // A logged-out visitor sees the published page.
  const visitor = await browser.newContext();
  const pub = await visitor.newPage();
  const res = await pub.goto(`/${slug}`);
  expect(res?.status()).toBe(200);
  await expect(pub.locator('main')).toContainText('Hello full flow.');
  await expect(pub.locator('main')).toContainText('Marina at dusk');
  await expect(pub.locator('main')).toContainText('Full flow hero');
  await visitor.close();
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

  await dropBelow(page, 'Image', para);
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

test('an image edit applied offline syncs on reconnect', async ({ page, context }) => {
  await login(page);
  const slug = `e2e-figure-offline-edit-${Date.now()}`;
  const imageId = await uploadJpeg(page);
  await seedBlockPage(page, { slug, title: 'Offline edit', body: [figureBlock(imageId)] });

  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#rkr-blocks-page-body figure').first().click();
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
  const dialog = page.locator('[data-rkr-dialog]').filter({ hasText: 'Save figure' });
  await dialog.getByRole('button', { name: 'Edit image' }).click();
  await expect(page.locator('[data-rkr-dialog] #rkr-image-edit')).toHaveAttribute(
    'data-ready',
    'true'
  );

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Rotate right' }).click();
  await page.getByRole('button', { name: 'Apply edits' }).click();
  await expect(page.getByRole('button', { name: 'Back to figure' })).toHaveCount(0);

  const commit = page.waitForResponse(
    (r) => r.url().endsWith(`/admin/sidecar/${imageId}/commit`) && r.request().method() === 'POST'
  );
  await context.setOffline(false);
  expect((await commit).status()).toBe(200);
  const meta = await page.request.get(`/admin/sidecar/${imageId}/meta`);
  expect(((await meta.json()) as { ops: { type: string }[] }).ops.map((o) => o.type)).toEqual([
    'rotate'
  ]);
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

  await dropBelow(page, 'Video', para);
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

test('drag an existing figure to the bottom of the row lands beside its nearest block', async ({
  page
}) => {
  await login(page);
  const slug = `e2e-drag-figure-${Date.now()}`;
  const imageId = await uploadJpeg(page);
  await seedBlockPage(page, {
    slug,
    title: 'Drag figure',
    body: [
      figureBlock(imageId),
      {
        type: 'grid',
        slots: { cols: 2 },
        children: [{ type: 'text', markdown: 'Inside the row.' }]
      }
    ]
  });

  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#rkr-blocks-page-body figure').first().click();
  const handle = page.getByRole('button', { name: 'Drag to move' });
  await expect(handle).toBeVisible();

  const row = page.locator('#rkr-blocks-page-body .rkr-grid');
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  const moved = saveResponse(page, slug);
  await handle.dragTo(row, { targetPosition: { x: 4, y: box!.height - 3 } });
  await moved;

  await page.reload();
  const res = await page.request.get(`/admin/blocks/${slug}`);
  const { tree } = (await res.json()) as {
    tree: { body: { type: string; children?: { type: string }[] }[] };
  };
  expect(tree.body.map((n) => n.type)).toEqual(['grid']);
  expect(tree.body[0]?.children?.map((n) => n.type)).toEqual(['figure', 'text']);
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

const savePill = (page: Page) => page.locator('.rkr-unified-save-state');

test('offline text edit survives reload', async ({ page, context }) => {
  await login(page);
  const slug = `e2e-offline-${Date.now()}`;
  await seedBlockPage(page, { slug, title: 'Offline', markdown: 'Before going offline.' });
  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const para = page.locator('#rkr-blocks-page-body p').first();
  await expect(para).toHaveAttribute('contenteditable', 'true');

  await context.setOffline(true);
  await para.click();
  await para.fill('Written while offline.');
  await page.keyboard.press('Tab');
  await expect(savePill(page)).toHaveText('Offline, will sync');

  await dragTextAbove(page, para);
  await expect(savePill(page)).toHaveText('Reconnect to add or move blocks');
  await expect(page.locator('#rkr-blocks-page-body [data-rkr-blank]')).toHaveCount(0);

  // Keep saves failing while reconnecting, so only the reload can sync.
  const isSave = (url: URL) => url.pathname === `/admin/blocks/${slug}`;
  await page.route(isSave, (route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue()
  );
  const retried = page.waitForEvent('requestfailed', (r) => isSave(new URL(r.url())));
  await context.setOffline(false);
  await retried;
  await page.unroute(isSave);

  const synced = saveResponse(page, slug);
  await page.reload();
  expect((await synced).status()).toBe(200);
  await expect(page.locator('#rkr-blocks-page-body p').first()).toHaveText(
    'Written while offline.'
  );
  await expect(savePill(page)).toHaveText('Restored unsaved changes');

  await page.goto(`/${slug}`);
  await expect(page.locator('article')).toContainText('Written while offline.');
});

test('offline upload shows its local thumbnail and syncs on reconnect', async ({
  page,
  context
}) => {
  await login(page);
  const slug = `e2e-offline-upload-${Date.now()}`;
  const imageId = await uploadJpeg(page);
  await seedBlockPage(page, { slug, title: 'Offline upload', body: [figureBlock(imageId)] });
  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#rkr-blocks-page-body figure').first().click();
  await page.getByRole('button', { name: 'Configure', exact: true }).click();
  const dialog = page.locator('[data-rkr-dialog]').filter({ hasText: 'Save figure' });
  await expect(dialog.locator('.rkr-media-row')).toHaveCount(1);

  await context.setOffline(true);
  await dialog.getByRole('button', { name: 'Add images' }).click();
  await chooseLocal(page, [
    { name: 'offline.png', mimeType: 'image/png', buffer: await makePng(Date.now()) }
  ]);
  await expect(dialog.locator('.rkr-media-row')).toHaveCount(2);
  await expect(dialog.locator('.rkr-media-row img').nth(1)).toHaveAttribute('src', /^blob:/);

  const synced = page.waitForResponse(
    (r) => r.url().endsWith('/admin/upload') && r.request().method() === 'POST'
  );
  await context.setOffline(false);
  expect((await synced).status()).toBe(200);
  const committed = saveResponse(page, slug);
  await dialog.getByRole('button', { name: 'Save figure' }).click();
  expect((await committed).status()).toBe(200);
  await expect(page.locator('#rkr-blocks-page-body figure img')).toHaveCount(2);
});

test('conflict dialog on concurrent edit', async ({ page, context }) => {
  await login(page);
  const slug = `e2e-conflict-${Date.now()}`;
  await seedBlockPage(page, { slug, title: 'Conflict', markdown: 'Shared start.' });
  const other = await context.newPage();
  for (const tab of [page, other]) {
    await tab.goto(`/admin/blocks/edit/${slug}`);
    await tab.getByRole('button', { name: 'Edit', exact: true }).click();
  }

  const edit = async (tab: Page, text: string) => {
    const para = tab.locator('#rkr-blocks-page-body p').first();
    await para.click();
    await para.fill(text);
    const saved = saveResponse(tab, slug);
    await tab.keyboard.press('Tab');
    return (await saved).status();
  };
  expect(await edit(page, 'From the first tab.')).toBe(200);
  expect(await edit(other, 'From the second tab.')).toBe(409);

  const dialog = other
    .locator('[data-rkr-dialog]')
    .filter({ hasText: 'This page changed somewhere else.' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Load latest' })).toBeVisible();
  const kept = saveResponse(other, slug);
  await dialog.getByRole('button', { name: 'Keep mine' }).click();
  expect((await kept).status()).toBe(200);
  await expect(savePill(other)).toHaveText('Saved');

  const res = await page.request.get(`/admin/blocks/${slug}`);
  const { tree } = (await res.json()) as { tree: { body: { markdown?: string }[] } };
  expect(tree.body[0]?.markdown).toBe('From the second tab.');
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

test('phone width add block via sheet', async ({ page }) => {
  await login(page);
  const slug = `e2e-sheet-${Date.now()}`;
  const filler = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
  await seedBlockPage(page, {
    slug,
    title: 'Sheet',
    body: [
      { type: 'text', markdown: filler },
      { type: 'text', markdown: 'Last block.' }
    ]
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const dock = page.locator('#rkr-unified-dock');
  await expect(dock).not.toBeInViewport();

  await page.locator('#rkr-blocks-page-body p').last().click();
  await page.getByRole('button', { name: 'Add block' }).click();
  await expect(dock).toBeVisible();
  const saved = saveResponse(page, slug);
  await paletteItem(page, 'Text').click();
  await saved;

  await expect(dock).not.toBeVisible();
  const blank = page.locator('#rkr-blocks-page-body [data-rkr-blank]');
  await expect(blank).toHaveCount(1);
  await expect(blank).toBeInViewport();
});

test('keyboard insert', async ({ page }) => {
  await login(page);
  const slug = `e2e-kbd-insert-${Date.now()}`;
  await seedBlockPage(page, { slug, title: 'Keyboard', markdown: 'One.' });
  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();

  const saved = saveResponse(page, slug);
  await paletteItem(page, 'Text').focus();
  await page.keyboard.press('Enter');
  await saved;

  await expect(page.locator('#rkr-blocks-page-body [data-rkr-blank]')).toHaveCount(1);
  await expect(page.locator('#rkr-blocks-page-body [data-rkr-selected]')).toHaveAttribute(
    'data-rkr-path',
    '1'
  );
});

test('phone preview narrows body', async ({ page }) => {
  await login(page);
  const slug = `e2e-phone-preview-${Date.now()}`;
  await seedBlockPage(page, { slug, title: 'Preview', markdown: 'Wide page.' });
  await page.goto(`/admin/blocks/edit/${slug}`);
  const body = page.locator('#rkr-blocks-page-body');
  const wide = await body.evaluate((el) => el.clientWidth);
  expect(wide).toBeGreaterThan(500);

  await page.getByRole('button', { name: 'Phone preview' }).click();
  expect(await body.evaluate((el) => el.clientWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Phone preview' }).click();
  expect(await body.evaluate((el) => el.clientWidth)).toBe(wide);
});

test('a multi-element text block is outlined as one box', async ({ page }) => {
  await login(page);
  const slug = `e2e-outline-${Date.now()}`;
  await seedBlockPage(page, {
    slug,
    title: 'Outline',
    markdown: '# A heading\n\nBody paragraph under it.'
  });
  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const heading = page.locator('#rkr-blocks-page-body h1');
  const para = page.locator('#rkr-blocks-page-body p');
  await para.click();

  await expect(page.locator('.rkr-block-outline')).toHaveCount(1);
  const h = (await heading.boundingBox())!;
  const p = (await para.boundingBox())!;
  const o = (await page.locator('.rkr-block-outline').boundingBox())!;
  expect(o.y).toBeLessThanOrEqual(h.y);
  expect(o.y + o.height).toBeGreaterThanOrEqual(p.y + p.height);
  for (const el of [heading, para]) {
    expect(await el.evaluate((n) => getComputedStyle(n).outlineStyle)).toBe('none');
  }
});

test('block toolbar stays below the sticky page toolbar at phone width', async ({ page }) => {
  await login(page);
  const slug = `e2e-toolbar-overlap-${Date.now()}`;
  await seedBlockPage(page, { slug, title: 'Overlap', markdown: 'Near the top.' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#rkr-blocks-page-body p').click();

  const sticky = (await page.locator('#rkr-unified-toolbar').boundingBox())!;
  const bar = page.locator('.rkr-block-toolbar');
  await expect(bar).toBeVisible();
  const box = (await bar.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(sticky.y + sticky.height - 0.5);
});

test('sticky toolbar is compact at phone width', async ({ page }) => {
  await login(page);
  const slug = `e2e-compact-toolbar-${Date.now()}`;
  await seedBlockPage(page, {
    slug,
    title: 'A reasonably long page title for the toolbar',
    markdown: 'Hi.'
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/admin/blocks/edit/${slug}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const bar = page.locator('#rkr-unified-toolbar');
  expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(88);
});
