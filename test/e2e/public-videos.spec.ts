// Public-side video delivery: a post carrying a `::video` directive
// renders the <figure class="rkr-video"> widget, and the derivative URLs
// it points at serve correctly — full 200 for the mp4, 206 with a Range
// header (the <video> element's byte-seeking request), and 200 image/jpeg
// for the poster. Unknown / stale / malformed ids 404. The derivative
// serving lives in src/routes/public-video.ts, which the unit tests cover
// with a stubbed render; this spec drives the real ffmpeg render once, so
// the Range/206 + immutable-cache path is exercised against real bytes.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/** Generate a tiny 2s 160x120 h264/aac mp4 via ffmpeg. The mp4 muxer
 * refuses non-seekable (pipe) output, so write to a temp file. */
function makeFixtureMp4(): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-video-fixture-'));
  const out = path.join(dir, 'clip.mp4');
  try {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=160x120:rate=15',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        out
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    );
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('site: public video derivative serves full + Range/206 + poster; bad ids 404', async ({
  page
}) => {
  test.setTimeout(120_000);
  await login(page);

  // Seed one real video (upload ingests + renders synchronously) and a
  // post referencing it by full id.
  const uploadRes = await page.request.post('/admin/upload/video', {
    multipart: { file: { name: 'clip.mp4', mimeType: 'video/mp4', buffer: makeFixtureMp4() } }
  });
  expect(uploadRes.status()).toBe(200);
  const upload = (await uploadRes.json()) as {
    id: string;
    videoUrl: string;
    posterUrl: string;
  };
  const slug = `e2e-videos-${Date.now()}`;
  await seedPost(page, {
    title: 'video post',
    slug,
    markdown: `::video{ids="${upload.id}"}\n`
  });

  // ---- the rendered post carries the widget ---------------------------

  const res = await page.request.get(`/${slug}`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('class="rkr-video');
  expect(html).toContain('<video');
  expect(html).toContain(`src="${upload.videoUrl}"`);
  expect(html).toContain(`poster="${upload.posterUrl}"`);

  // ---- the live page shows the element + loads the poster ------------

  await page.goto(`/${slug}`);
  const video = page.locator('figure.rkr-video video');
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute('poster', upload.posterUrl);
  // The poster is a jpeg the browser can actually decode (the mp4 itself
  // is h264/aac, which Playwright's codec-free chromium build won't
  // play — so assert the image path, not video playback).
  const posterLoaded = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img.naturalWidth > 0;
  }, upload.posterUrl);
  expect(posterLoaded).toBe(true);

  // ---- derivative serving: 200, Range/206, immutable cache -----------

  const full = await page.request.get(upload.videoUrl);
  expect(full.status()).toBe(200);
  expect(full.headers()['content-type']).toBe('video/mp4');
  expect(full.headers()['accept-ranges']).toBe('bytes');
  expect(full.headers()['cache-control']).toContain('immutable');

  const range = await page.request.get(upload.videoUrl, { headers: { Range: 'bytes=0-99' } });
  expect(range.status()).toBe(206);
  expect(range.headers()['content-range']).toMatch(/^bytes 0-99\/\d+$/);
  expect(Number(range.headers()['content-length'])).toBe(100);

  const poster = await page.request.get(upload.posterUrl);
  expect(poster.status()).toBe(200);
  expect(poster.headers()['content-type']).toBe('image/jpeg');

  // ---- negative cases -------------------------------------------------

  // Unknown original id with a well-formed ophash → 404.
  const ghost = `${'0'.repeat(64)}.${'0'.repeat(12)}.mp4`;
  expect((await page.request.get(`/video/${ghost}`)).status()).toBe(404);
  // Malformed filename never reaches the sidecar lookup.
  expect((await page.request.get('/video/not-a-video')).status()).toBe(404);
});
