// End-to-end coverage for the video admin flow:
//   1. Upload a real mp4 → POST /admin/upload/video ingests, probes with
//      ffprobe, and synchronously renders the mp4 + jpeg poster so the
//      returned URLs serve immediately.
//   2. Trim      → POST /admin/video/:id/trim rewrites the sidecar; the
//      old ophash URL goes stale (404) and the new one renders on first
//      request.
//   3. Editor    → the ::video node inserted via window.__rkrEditor
//      serializes to a `::video` directive on Save and the public post
//      renders <figure class="rkr-video"> with the trimmed derivative.
//
// The fixture mp4 is generated with ffmpeg at test time (testsrc + sine,
// 2s, 160x120 h264/aac) — no binary fixtures in the repo. That makes
// ffmpeg/ffprobe a hard prerequisite of the e2e suite, same as chromium.

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

/** Flip a saved post to 'published' (the editor saves drafts). */
async function publishSlug(page: import('@playwright/test').Page, slug: string): Promise<void> {
  const res = await page.request.post(`/admin/posts/${encodeURIComponent(slug)}/status`, {
    form: { status: 'published' }
  });
  if (res.status() !== 200 && res.status() !== 303) {
    throw new Error(`publish ${slug}: ${res.status()} ${await res.text()}`);
  }
}

async function setSlug(page: import('@playwright/test').Page, slug: string): Promise<void> {
  await page.locator('#rkr-slug').evaluate((el, v) => {
    (el as HTMLInputElement).value = v as string;
  }, slug);
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

interface UploadResult {
  id: string;
  videoUrl: string;
  posterUrl: string;
  durationMs: number;
  width: number;
  height: number;
}

test('video: upload, trim persists, editor save publishes the trimmed derivative', async ({
  page
}) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  // ---- 1. upload ------------------------------------------------------

  const mp4 = makeFixtureMp4();
  const uploadRes = await page.request.post('/admin/upload/video', {
    multipart: { file: { name: 'clip.mp4', mimeType: 'video/mp4', buffer: mp4 } }
  });
  expect(uploadRes.status()).toBe(200);
  const upload = (await uploadRes.json()) as UploadResult;
  expect(upload.id).toMatch(/^[0-9a-f]{64}$/);
  expect(upload.width).toBe(160);
  expect(upload.height).toBe(120);

  // The upload route renders synchronously: both derivative URLs serve
  // immediately, the mp4 with Range support.
  const videoHit = await page.request.get(upload.videoUrl, { headers: { Range: 'bytes=0-99' } });
  expect(videoHit.status()).toBe(206);
  expect(videoHit.headers()['content-range']).toMatch(/^bytes 0-99\//);
  const posterHit = await page.request.get(upload.posterUrl);
  expect(posterHit.status()).toBe(200);
  expect(posterHit.headers()['content-type']).toBe('image/jpeg');

  // ---- 2. trim --------------------------------------------------------

  const trimRes = await page.request.post(`/admin/video/${upload.id}/trim`, {
    form: { startMs: '500', endMs: '1500', posterTimeMs: '1000' }
  });
  expect(trimRes.status()).toBe(200);
  const trimmed = (await trimRes.json()) as { videoUrl: string; posterUrl: string };
  expect(trimmed.videoUrl).not.toBe(upload.videoUrl);
  expect(trimmed.posterUrl).not.toBe(upload.posterUrl);

  // Trim persisted to the sidecar: the pre-trim ophash no longer
  // validates (404), and the new derivative renders on first request.
  expect((await page.request.get(upload.videoUrl)).status()).toBe(404);
  await expect
    .poll(
      async () => {
        const res = await page.request.get(trimmed.videoUrl, {
          headers: { Range: 'bytes=0-99' }
        });
        return res.status();
      },
      { timeout: 30_000 }
    )
    .toBe(206);

  // ---- 3. editor insert + save ----------------------------------------

  const slug = `e2e-video-${Date.now()}`;
  await page.locator('#rkr-title').fill('e2e video');
  await setSlug(page, slug);
  // Insert the video node through the e2e hook: the TipTap node's attrs
  // (trim/poster/caption) serialize into the ::video directive on save.
  await page.evaluate((id) => {
    const ed = (window as unknown as { __rkrEditor?: import('@tiptap/core').Editor }).__rkrEditor;
    if (!ed) throw new Error('window.__rkrEditor not exposed; ?e2e=1 missing');
    ed.chain()
      .focus()
      .insertContent({
        type: 'video',
        attrs: { ids: id, trim: '0.5-1.5', poster: '1.0', caption: 'e2e clip' }
      })
      .run();
  }, upload.id);
  await expect(page.locator('.rkr-video-placeholder[data-video]')).toHaveCount(1);

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(`saved /${slug}`, {
    timeout: 10_000
  });
  await publishSlug(page, slug);

  // ---- 4. public post renders the widget ------------------------------

  const res = await page.request.get(`/${slug}`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  // The widget emits <figure class="rkr-video"> wrapping a <video> whose
  // src/poster are the *trimmed* derivative URLs — proves the trim op
  // survived sidecar → directive → widget render.
  expect(html).toContain('class="rkr-video');
  expect(html).toContain('<video');
  expect(html).toContain(`src="${trimmed.videoUrl}"`);
  expect(html).toContain(`poster="${trimmed.posterUrl}"`);
  expect(html).toMatch(/data-duration="\d+"/);
  expect(html).toContain('e2e clip');
});

test('video: toolbar +Video uploads the picked file and inserts a video node', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  await page.getByRole('button', { name: '+Video' }).click();
  await page.locator('#rkr-video-input').setInputFiles({
    name: 'toolbar.mp4',
    mimeType: 'video/mp4',
    buffer: makeFixtureMp4()
  });

  await expect(page.locator('.rkr-video-placeholder[data-video]')).toHaveCount(1, {
    timeout: 60_000
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText('uploaded toolbar.mp4');

  // The node view renders a bare placeholder, so read the id off the doc.
  const ids = await page.evaluate(() => {
    const ed = (window as unknown as { __rkrEditor?: import('@tiptap/core').Editor }).__rkrEditor;
    if (!ed) throw new Error('window.__rkrEditor not exposed; ?e2e=1 missing');
    let found: string | null = null;
    ed.state.doc.descendants((node) => {
      if (node.type.name === 'video') found = (node.attrs as { ids?: string }).ids ?? null;
      return found === null;
    });
    return found;
  });
  expect(ids).toMatch(/^[0-9a-f]{64}$/);
});
