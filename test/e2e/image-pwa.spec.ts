// Smoke test for the standalone image PWA served from apps/image-pwa/dist:
//   load → upload a fixture → rotate → crop → download
// The blog's own editor is covered by editor-flow.spec.ts; this only
// asserts the standalone app boots and its four core ops round-trip.

import { expect, test } from './coverage-fixtures.ts';

test('image-pwa: upload, rotate, crop and download round-trip', async ({ page }) => {
  await page.goto('/pwa/');

  await page.getByLabel(/open image/i).setInputFiles({
    name: 'fixture.png',
    mimeType: 'image/png',
    // 4x2 solid-red PNG so a rotate is observable in the output dimensions.
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGP4z8DwHxkzoAsAAA8hD/EEN8afAAAAAElFTkSuQmCC',
      'base64'
    )
  });

  await expect(page.locator('#status')).toContainText('×');

  await page.getByRole('button', { name: 'Rotate right' }).click();

  await page.getByRole('button', { name: 'Crop' }).click();
  // openCropper mounts cropperjs asynchronously; its status readout
  // flips to `${w}×${h} current` once ready, same signal editor-flow
  // uses. autoCropArea:1 gives a full-extent crop with no drag needed.
  await expect(page.locator('#rkr-crop-status')).toContainText('×');
  await page.locator('#rkr-crop-save').click();
  await expect(page.locator('#rkr-crop-modal')).not.toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download' }).click()
  ]);
  expect(download.suggestedFilename()).toMatch(/-edited\.(png|jpe?g|webp)$/);
});
