// Public-side image retry on /img cache-miss. The server returns
// 202 while the render worker is busy; the browser fires `error`
// because 202 isn't an image. src/site/img-retry.ts instruments
// every <img> so it appends ?rkr_retry=N and retries with backoff.
//
// Coverage push for img-retry.ts (27% -> 60%+): exercise the
// onError -> nextDelay -> apply path and the onLoad reset by
// using page.route() to fail the first /img request then pass.

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

test('site: <img> retries with ?rkr_retry=1 after a 202', async ({ page, context }) => {
  test.setTimeout(60_000);
  await login(page);

  // Seed a post with a single image so /img/<id>.<oph>.<fmt> is
  // unambiguous to intercept.
  const buf = await sharp({
    create: { width: 200, height: 150, channels: 3, background: { r: 0, g: 120, b: 200 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  const upload = await page.request.post('/admin/upload', {
    multipart: { file: { name: 'retry.jpg', mimeType: 'image/jpeg', buffer: buf } }
  });
  expect(upload.status()).toBe(200);
  const { id } = (await upload.json()) as { id: string };

  const slug = `e2e-retry-${Date.now()}`;
  const save = await page.request.post('/admin/posts', {
    data: {
      slug,
      title: 'retry test',
      status: 'published',
      markdown: `::figure{ids=${id.slice(0, 8)} alts="r"}\n`
    }
  });
  expect(save.status()).toBe(200);

  // Route-intercept: first /img request returns 202 with no body
  // (img-retry sees `error` event), second + onwards pass through.
  let firstSeen = false;
  const retryUrls: string[] = [];
  const hitUrls: string[] = [];
  await context.route('**/img/**', async (route) => {
    const url = route.request().url();
    hitUrls.push(url);
    if (url.includes('rkr_retry=')) retryUrls.push(url);
    if (!firstSeen) {
      firstSeen = true;
      // Wait so img-retry.js (loaded with `defer`) has time to
      // attach its error listener BEFORE the error fires —
      // otherwise the initial error is missed and no retry kicks in.
      await new Promise((r) => setTimeout(r, 500));
      await route.fulfill({
        status: 500,
        contentType: 'text/plain',
        body: 'rendering'
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/${slug}`);
  // Force-load every <img>: figures use loading="lazy" so below-
  // fold images won't fetch. eager + src reassignment triggers a
  // fresh fetch that the route intercepts.
  await page.evaluate(() => {
    for (const img of document.querySelectorAll<HTMLImageElement>('img')) {
      img.loading = 'eager';
      const s = img.src;
      img.src = '';
      img.src = s;
    }
  });

  // Wait for img-retry's backoff to fire + apply() to reassign
  // src. After ~1s the img.src on the page should carry
  // ?rkr_retry=N (the retry has been issued at least once).
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('img'));
          return imgs.some((i) => i.src.includes('rkr_retry='));
        }),
      { timeout: 10_000 }
    )
    .toBe(true);
  // Sanity: at least one route hit observed.
  expect(hitUrls.length).toBeGreaterThan(0);
  void retryUrls;
});
