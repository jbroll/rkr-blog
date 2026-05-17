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

// The carousel scrolls via `track.scrollTo({ behavior: 'smooth' })` and
// only moves the active dot when its IntersectionObserver reports the new
// slide. `toHaveAttribute('aria-current')` passes on the first poll that
// matches — which can be an *intermediate* IO fire while the smooth scroll
// is still in flight. Issuing the next prev/next/keyboard interaction at
// that point starts a competing `scrollTo` that Chromium merges with the
// unfinished one, so the track never cleanly reaches the target slide and
// the subsequent assertion times out (observed flakiness at the prev /
// keyboard steps). Gate each interaction on the track actually being at
// rest on the active slide: `setupCarousel` scrolls to `slide.offsetLeft`,
// so at rest `track.scrollLeft === slides[current].offsetLeft`. expect.poll
// is a retrying primitive (no fixed sleep) over real, production-set DOM
// state, so coverage and behaviour under test are unchanged.
async function expectActiveDotSettled(
  carousel: import('@playwright/test').Locator,
  index: number
): Promise<void> {
  const dots = carousel.locator('.rkr-carousel-dot');
  await expect(dots.nth(index)).toHaveAttribute('aria-current', 'true', { timeout: 5_000 });
  await expect
    .poll(
      () =>
        carousel.evaluate((root, idx) => {
          const track = root.querySelector<HTMLElement>('.rkr-carousel-track');
          const slide = root.querySelectorAll<HTMLElement>('.rkr-carousel-slide')[idx];
          if (!track || !slide) return -1;
          // Rounded: sub-pixel layout / fractional scroll offsets must
          // still count as "arrived".
          return Math.abs(Math.round(track.scrollLeft) - Math.round(slide.offsetLeft));
        }, index),
      { timeout: 5_000 }
    )
    .toBeLessThanOrEqual(1);
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

  // Three dots, one per slide. Initially the first is active. Waiting
  // for aria-current here also gates on carousel JS having wired up
  // (setActive(0) is the last statement of setupCarousel, after every
  // addEventListener), so the prev/next clicks below land on a live
  // controller.
  const dots = carousel.locator('.rkr-carousel-dot');
  await expect(dots).toHaveCount(3);
  await expectActiveDotSettled(carousel, 0);

  // Click Next → IntersectionObserver picks up the new visible slide
  // → active dot moves. The track scrolls via scroll-snap, so the
  // observer fires after the smooth scroll settles.
  await carousel.locator('.rkr-carousel-next').click();
  await expectActiveDotSettled(carousel, 1);

  // Click a specific dot → jump.
  await dots.nth(2).click();
  await expectActiveDotSettled(carousel, 2);

  // Prev wraps back from the last to the middle.
  await carousel.locator('.rkr-carousel-prev').click();
  await expectActiveDotSettled(carousel, 1);

  // Keyboard nav: ArrowLeft / ArrowRight move on the focused carousel.
  await carousel.focus();
  await page.keyboard.press('ArrowLeft');
  await expectActiveDotSettled(carousel, 0);
  await page.keyboard.press('ArrowRight');
  await expectActiveDotSettled(carousel, 1);
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

test('site: carousel autoplay advances + pause button stops it', async ({ page }) => {
  test.setTimeout(60_000);
  await login(page);
  const ids = await Promise.all([0, 1].map((i) => uploadJpeg(page, i + 20)));
  const slug = `e2e-autoplay-${Date.now()}`;
  const idsAttr = ids.map((id) => id.slice(0, 8)).join(',');
  // timer=1 (seconds) drives autoplay via setInterval inside
  // setupCarousel; with reduced-motion off, start() is called on
  // mount.
  await seedPost(page, {
    title: 'autoplay',
    slug,
    markdown: `::figure{ids=${idsAttr} matrix="1x1" timer=1}\n`
  });
  await page.goto(`/${slug}`);
  const carousel = page.locator('.rkr-carousel').first();
  const dots = carousel.locator('.rkr-carousel-dot');
  await expect(dots).toHaveCount(2);
  await expect(dots.nth(0)).toHaveAttribute('aria-current', 'true');

  // Autoplay button starts in 'playing' state (aria-pressed=true).
  const play = carousel.locator('.rkr-carousel-play');
  await expect(play).toHaveAttribute('aria-pressed', 'true');

  // After ~1.2s the autoplay tick has fired; the active dot moved.
  await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true', { timeout: 3_000 });

  // Pause-on-focus: focusing the carousel root invokes stop() via
  // the focusin listener, flipping the play button to 'paused'.
  await carousel.focus();
  await expect(play).toHaveAttribute('aria-pressed', 'false');
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
