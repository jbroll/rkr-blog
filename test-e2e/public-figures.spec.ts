// Public-side figure UI: carousel nav + PhotoSwipe lightbox. Both
// scripts (src/site/carousel.ts, src/site/lightbox.ts) ship in the
// public bundle and start with default-DOMContentLoaded init. The
// e2e coverage of those modules sat around 9% and 45% respectively
// before this spec — most carousel branches (prev/next/dot click,
// keyboard nav, autoplay pause) and the lightbox open/close path
// went unexercised. This spec drives both end-to-end through a
// real saved-and-rendered post.

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

async function seedPost(
  page: import('@playwright/test').Page,
  body: { title: string; markdown: string; slug: string }
): Promise<void> {
  const res = await page.request.post('/admin/posts', {
    data: { slug: body.slug, title: body.title, status: 'published', markdown: body.markdown }
  });
  expect(res.status()).toBe(200);
}

async function uploadJpeg(page: import('@playwright/test').Page, seed: number): Promise<string> {
  const buf = await sharp({
    create: {
      width: 320 + seed,
      height: 240 + seed,
      channels: 3,
      background: { r: 200 - seed * 30, g: 80, b: 60 + seed * 40 }
    }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  const res = await page.request.post('/admin/upload', {
    multipart: { file: { name: `c-${seed}.jpg`, mimeType: 'image/jpeg', buffer: buf } }
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { id: string };
  return body.id;
}

test('site: carousel prev/next/dot/keyboard nav updates the active dot', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  // 3 images in a 1×1 matrix → carousel mode (cells > rows*cols).
  const ids = await Promise.all([0, 1, 2].map((i) => uploadJpeg(page, i)));
  const slug = `e2e-carousel-${Date.now()}`;
  const idsAttr = ids.map((id) => id.slice(0, 8)).join(',');
  await seedPost(page, {
    title: 'carousel test',
    slug,
    markdown: `::figure{ids=${idsAttr} matrix="1x1"}\n`
  });

  await page.goto(`/${slug}`);
  const carousel = page.locator('.rkr-carousel').first();
  await expect(carousel).toBeVisible();

  // Three dots, one per slide. Initially the first is active.
  const dots = carousel.locator('.rkr-carousel-dot');
  await expect(dots).toHaveCount(3);
  await expect(dots.nth(0)).toHaveAttribute('aria-current', 'true', { timeout: 5_000 });

  // Click Next → IntersectionObserver picks up the new visible slide
  // → active dot moves. The track scrolls via scroll-snap, so the
  // observer fires after the smooth scroll settles.
  await carousel.locator('.rkr-carousel-next').click();
  await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true', { timeout: 5_000 });

  // Click a specific dot → jump.
  await dots.nth(2).click();
  await expect(dots.nth(2)).toHaveAttribute('aria-current', 'true', { timeout: 5_000 });

  // Prev wraps back from the last to the middle.
  await carousel.locator('.rkr-carousel-prev').click();
  await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true', { timeout: 5_000 });

  // Keyboard nav: ArrowLeft / ArrowRight move on the focused carousel.
  await carousel.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(dots.nth(0)).toHaveAttribute('aria-current', 'true', { timeout: 5_000 });
  await page.keyboard.press('ArrowRight');
  await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true', { timeout: 5_000 });
});

test('site: figure cell opens the PhotoSwipe lightbox', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  const ids = await Promise.all([0, 1].map((i) => uploadJpeg(page, i + 3)));
  const slug = `e2e-lightbox-${Date.now()}`;
  const idsAttr = ids.map((id) => id.slice(0, 8)).join(',');
  await seedPost(page, {
    title: 'lightbox test',
    slug,
    markdown: `::figure{ids=${idsAttr} caption="A two-up figure"}\n`
  });

  await page.goto(`/${slug}`);
  // Each cell wraps a <picture> in an <a data-pswp-width …> that
  // PhotoSwipe hijacks on click.
  const anchors = page.locator('figure.rkr-figure a[data-pswp-width]');
  await expect(anchors).toHaveCount(2);

  // Wait for the source image to actually load so PhotoSwipe has
  // dims; clicking an anchor whose <img> hasn't loaded leaves the
  // lightbox in a "loading" state that's hard to assert against.
  await page.evaluate(async () => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('img'));
    await Promise.all(imgs.map((i) => (i.complete ? null : i.decode().catch(() => null))));
  });

  // Click the first cell → PhotoSwipe injects its own DOM rooted
  // at .pswp; visibility is the open-state signal. The close-on-
  // ESC / close-button path stays in PhotoSwipe's domain and is
  // outside what this test covers — the lightbox-init + open path
  // is what we want exercised for src/site/lightbox.ts coverage.
  await anchors.first().click();
  const pswp = page.locator('.pswp');
  await expect(pswp).toBeVisible({ timeout: 5_000 });
});

test('site: single-image figure renders without carousel chrome', async ({ page }) => {
  // Negative case so the carousel test's "first dot active" assertion
  // hasn't accidentally flipped on a default that always applies.
  await login(page);
  const id = await uploadJpeg(page, 10);
  const slug = `e2e-singleton-${Date.now()}`;
  await seedPost(page, {
    title: 'one image',
    slug,
    markdown: `::figure{ids=${id.slice(0, 8)}}\n`
  });
  await page.goto(`/${slug}`);
  await expect(page.locator('figure.rkr-figure').first()).toBeVisible();
  // Single-image figure has no carousel track / nav.
  await expect(page.locator('.rkr-carousel')).toHaveCount(0);
});
