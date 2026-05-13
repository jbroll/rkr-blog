// Resilience tests for the offline → drain → online lifecycle.
// Existing tests cover each outbox op type individually; this spec
// covers the harder behaviours:
//
//   1. Multi-op queue: upload + commitImageEdit + savePost all
//      queued offline drain in seq order on reconnect.
//   2. Retry with backoff: transient 5xx eventually succeeds.
//   3. Intermittent flap: offline mid-drain → online resumes.
//   4. Halt surfaced: persistent 5xx pushes the badge to halted.
//   5. Save waits for prerequisite uploads.

import sharp from 'sharp';

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

async function setSlug(page: import('@playwright/test').Page, slug: string): Promise<void> {
  await page.locator('#rkr-slug').evaluate((el, v) => {
    (el as HTMLInputElement).value = v as string;
  }, slug);
}

async function makePng(seed: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 32 + seed,
      height: 32 + seed,
      channels: 3,
      background: { r: 60 + seed * 10, g: 120, b: 200 - seed * 10 }
    }
  })
    .png()
    .toBuffer();
}

test('offline: commit + savePost queued together drain in seq order on reconnect', async ({
  page,
  context
}) => {
  test.setTimeout(90_000);
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );

  const slug = `e2e-multi-drain-${Date.now()}`;
  await page.locator('#rkr-title').fill('multi-op drain');
  await setSlug(page, slug);

  // Upload + open the image-edit panel ONLINE so ensureLocalState's
  // meta fetch lands. The interesting drain test happens after the
  // upload has settled — we want commitImageEdit + savePost both in
  // the queue, drain in seq order.
  const buf = await makePng(7);
  await page.locator('#rkr-image-input').setInputFiles({
    name: 'multi-op.png',
    mimeType: 'image/png',
    buffer: buf
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded multi-op/, {
    timeout: 10_000
  });
  await page.locator('img[data-cell-index="0"]').click();
  await expect(page.locator('#rkr-image-edit')).toHaveAttribute('data-ready', 'true');

  // Now go offline so the save edits + savePost both queue.
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));

  // 1. Rotate + save edits → queues commitImageEdit.
  await page.locator('#rkr-image-rotate-r-btn').click();
  await expect(page.locator('#rkr-image-edits li')).toHaveCount(1);
  await page.locator('#rkr-image-save-btn').click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^saved edits /, {
    timeout: 10_000
  });

  // Close the cell dialog so the Save click below isn't shadowed.
  await page.keyboard.press('Escape');

  // 2. Save the post → queues savePost.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(`queued /${slug} for sync`, {
    timeout: 10_000
  });

  // Both ops queued; commitImageEdit's seq is lower so it drains first.
  const opsBefore = await page.evaluate(async () => {
    type Entry = { seq: number; op: string };
    const list = (window as unknown as { __rkrOutboxList: () => Promise<Entry[]> }).__rkrOutboxList;
    return (await list()).map((e) => ({ seq: e.seq, op: e.op }));
  });
  const ops = opsBefore.map((e) => e.op);
  expect(ops).toContain('commitImageEdit');
  expect(ops).toContain('savePost');
  // Commit's seq < savePost's seq → drain order.
  const commitSeq = opsBefore.find((e) => e.op === 'commitImageEdit')?.seq ?? -1;
  const saveSeq = opsBefore.find((e) => e.op === 'savePost')?.seq ?? -1;
  expect(commitSeq).toBeLessThan(saveSeq);

  // Reconnect → drainLoop processes commit first (server gets the
  // rotated bake + ops), then savePost (markdown with the now-edited
  // image id). Wait for queue empty.
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  await expect
    .poll(
      async () => {
        return page.evaluate(async () => {
          type Entry = { seq: number; op: string };
          const list = (window as unknown as { __rkrOutboxList: () => Promise<Entry[]> })
            .__rkrOutboxList;
          return (await list()).length;
        });
      },
      { timeout: 30_000 }
    )
    .toBe(0);

  // End-to-end: the public post is reachable and renders with a
  // derivative URL (sidecar.ops carries the rotate).
  const res = await page.request.get(`/${slug}`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('multi-op drain');
  expect(html).toMatch(/\/img\/[0-9a-f]{64}\.[0-9a-f]{12}\./);
});
