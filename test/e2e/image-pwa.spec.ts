// Smoke test for the standalone image PWA served from apps/image-pwa/dist:
//   load → upload a fixture → rotate → crop → download
// The blog's own editor is covered by editor-flow.spec.ts; this only
// asserts the standalone app boots and its four core ops round-trip.

import { expect, test } from './coverage-fixtures.ts';

test('image-pwa: upload, rotate, crop and download round-trip', async ({ page }) => {
  // sw.js is deliberately unserved (see the brief); stub registration so
  // main.ts's `.catch(() => {})` never turns into a console 404.
  await page.addInitScript(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register = () => Promise.reject(new Error('stubbed for e2e'));
    }
  });

  await page.goto('/pwa/');

  await page.getByLabel(/open image/i).setInputFiles({
    name: 'fixture.png',
    mimeType: 'image/png',
    // 4x2 solid-red PNG so a 90° rotate is observable as a dimension swap.
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGP4z8DwHxkzoAsAAA8hD/EEN8afAAAAAElFTkSuQmCC',
      'base64'
    )
  });

  await expect(page.locator('#status')).toContainText('4×2');
  const preview = page.locator('#preview');
  await expect(preview).toHaveJSProperty('naturalWidth', 4);
  await expect(preview).toHaveJSProperty('naturalHeight', 2);

  // A no-op rotate would leave these at 4×2; a real 90° turn swaps them.
  await page.getByRole('button', { name: 'Rotate right' }).click();
  await expect(preview).toHaveJSProperty('naturalWidth', 2);
  await expect(preview).toHaveJSProperty('naturalHeight', 4);

  await page.getByRole('button', { name: 'Crop' }).click();
  // openCropper mounts cropperjs asynchronously; its status readout reports
  // the post-ops (post-rotate) canvas size once ready, so this also proves
  // the rotate op is what the cropper is operating on.
  await expect(page.locator('#rkr-crop-status')).toContainText('2×4');
  // autoCropArea:1 gives a full-extent crop with no drag needed.
  await page.locator('#rkr-crop-save').click();
  await expect(page.locator('#rkr-crop-modal')).not.toBeVisible();

  // A full-extent crop leaves the rendered image unchanged, so its own
  // effect isn't visible. Prove save actually appended an op (not a silent
  // no-op) by undoing once: undo pops the crop and only the crop, so the
  // preview must stay at the rotated 2×4. A no-op crop would instead undo
  // the rotate, reverting to 4×2.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(preview).toHaveJSProperty('naturalWidth', 2);
  await expect(preview).toHaveJSProperty('naturalHeight', 4);
  await page.getByRole('button', { name: 'Redo' }).click();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click()
  ]);
  expect(download.suggestedFilename()).toMatch(/^fixture-edited\.(png|jpe?g|webp)$/);
});
