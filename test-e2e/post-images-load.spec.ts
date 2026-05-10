// Integration test for the image pipeline: save a multi-image post,
// immediately request /<slug>, observe every <img> eventually loads.
// Exercises pre-warm-on-save + render dedup + indefinite client
// retry as one closed loop.
//
// Local runs catch logic regressions (retry dropping back to 3
// attempts, pre-warm not enqueueing, dedup map bug, etc.) but won't
// reproduce CPU exhaustion on a multi-core dev box. Set
// PLAYWRIGHT_BASE_URL=https://your-fly-host to re-run the same spec
// against the deployed single-CPU machine — the same assertions
// apply.

import sharp from 'sharp';

import { expect, test } from './coverage-fixtures.ts';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';
const N_IMAGES = 6;

async function makeJpeg(seed: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 320 + seed,
      height: 240 + seed,
      channels: 3,
      background: { r: 90 + (seed % 100), g: 30, b: 200 - (seed % 100) }
    }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL('**/admin/editor'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
}

test('site: multi-image post served immediately after save — every <img> loads', async ({
  page
}) => {
  // Default Playwright timeout is 30s; this test polls images for
  // up to 60s and uploads N originals first, so the budget is
  // closer to 90s.
  test.setTimeout(120_000);
  await login(page);

  // Upload N real-sized JPEGs via the admin API; capture each id.
  // 1×1 sources won't exercise the resize pipeline (sharp's default
  // doesn't enlarge below source dimensions); 320+px sources hit
  // every variant width the figure widget declares.
  const ids: string[] = [];
  for (let i = 0; i < N_IMAGES; i++) {
    const buf = await makeJpeg(i);
    const res = await page.request.post('/admin/upload', {
      multipart: {
        file: {
          name: `pic-${i}.jpg`,
          mimeType: 'image/jpeg',
          buffer: buf
        }
      }
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { id: string };
    ids.push(body.id);
  }

  // Save a post with N ::figure directives — one per image, each
  // a single-image figure. Pre-warm-on-save enqueues every
  // (variant × output) combo into the worker queue.
  const slug = `e2e-multi-${Date.now()}`;
  const refs = ids.map((id, i) => `::figure{ids=${id.slice(0, 8)} alts="img-${i}"}`).join('\n\n');
  const save = await page.request.post('/admin/posts', {
    data: {
      slug,
      title: 'multi-image post',
      status: 'published',
      markdown: `${refs}\n`
    }
  });
  expect(save.status()).toBe(200);

  // Capture every /img response so we can assert the eventual
  // status of each. Browser fires multiple requests per <img> as
  // retry kicks in — we keep the most recent status per URL.
  const imgStatusByUrl = new Map<string, number>();
  page.on('response', (resp) => {
    const url = resp.url();
    if (url.includes('/img/')) {
      // Strip rkr_retry param so per-URL bookkeeping coalesces
      // the retry sequence.
      const stripped = url.replace(/[?&]rkr_retry=\d+/, '').replace(/\?$/, '');
      imgStatusByUrl.set(stripped, resp.status());
    }
  });

  // Visit the post immediately. Pre-warm jobs may not be done yet;
  // some images will return 202 first and the client will retry.
  await page.goto(`/${slug}`);

  // Force-load every <img>: figures use loading="lazy" so below-
  // fold ones won't fetch until scrolled. Setting loading=eager +
  // resetting src triggers an immediate fetch.
  await page.evaluate(() => {
    for (const img of document.querySelectorAll<HTMLImageElement>('img')) {
      img.loading = 'eager';
      const s = img.src;
      img.src = '';
      img.src = s;
    }
  });

  // Manual poll so we can capture diagnostics on timeout instead
  // of bailing inside expect.poll's failure path.
  const deadline = Date.now() + 60_000;
  let final = { total: 0, loaded: 0, failed: 0 };
  while (Date.now() < deadline) {
    final = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('img'));
      return {
        total: imgs.length,
        loaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
        failed: imgs.filter((i) => i.dataset.rkrFailed === 'true').length
      };
    });
    if (final.total > 0 && final.loaded === final.total) break;
    if (final.failed > 0) break;
    await page.waitForTimeout(500);
  }

  expect(final.total).toBeGreaterThanOrEqual(N_IMAGES);
  expect(final.loaded).toBe(final.total);
  expect(final.failed).toBe(0);

  // Every distinct /img URL we observed eventually returned 200.
  for (const [url, status] of imgStatusByUrl) {
    expect(status, `final /img status: ${url} → ${status}`).toBe(200);
  }
});
