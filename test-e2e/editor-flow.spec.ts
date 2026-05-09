// End-to-end coverage for the editor's image flow:
//   1. Insert image  → POST /admin/upload + figure node inserted
//   2. Set matrix    → ::figure attrs panel writes through to the doc
//   3. Save          → POST /admin/posts persists markdown for /:slug
//
// The unit tests cover each route in isolation; this spec exercises the
// browser glue (TipTap insertContent, panel re-population on selection,
// JSON-to-markdown serialization on save) that only runs in a real DOM.

import { expect, test } from '@playwright/test';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

// 1×1 PNGs, inlined as base64 so the spec doesn't need fixture files
// and the bytes survive page.setInputFiles unchanged.
//
// Three distinct colors (black / red / blue) so each test that uploads
// gets a content-hashed id unique to that test. Otherwise the rotate
// test's saved ops carry over to the crop test (same bytes → same id
// → shared sidecar) and race with ensureLocalState resolution.
const PNG_1X1_BLACK =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_1X1_RED =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const PNG_1X1_BLUE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL('**/admin/editor'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
}

test('editor: insert image, set matrix, save publishes to /:slug', async ({ page }) => {
  await login(page);

  await page.locator('#rkr-title').fill('e2e flow');
  // Unique slug — the e2e site root persists for the run, so reusing one
  // would surface a "already exists" save error.
  const slug = `e2e-flow-${Date.now()}`;
  await page.locator('#rkr-slug').fill(slug);
  await page.locator('#rkr-status').selectOption('published');

  // ---- 1. insert image -------------------------------------------------

  await page.locator('#rkr-image-input').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_BLACK, 'base64')
  });

  // The toolbar's setStatus() trace becomes the visible status line and
  // is the only DOM signal that the upload + insert finished.
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded pixel\.png/, {
    timeout: 10_000
  });

  // The figure node now lives in the editor; the attrs panel reveals
  // itself when the figure is selected (which insertContent does).
  await expect(page.locator('#rkr-figure-attrs')).toBeVisible();
  // The 'ids' field is read-only and populated from the upload result
  // — non-empty here means the round-trip from /admin/upload landed.
  await expect(page.locator('#rkr-figure-ids')).not.toHaveValue('');

  // ---- 2. set matrix ---------------------------------------------------

  await page.locator('#rkr-figure-matrix').fill('1x2');
  // Commit the change — main.ts wires `input` events on text fields. We
  // dispatch one explicitly because Playwright's fill() does it for us,
  // but blur is needed to flush remaining commits in some flows.
  await page.locator('#rkr-figure-matrix').blur();

  // ---- 3. save ---------------------------------------------------------

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(`saved /${slug}`, {
    timeout: 10_000
  });

  // ---- verify the post is reachable on the public site ----------------

  // status=published was selected above, so /:slug renders the post.
  // The figure markdown directive becomes a <figure class="rkr-figure">
  // wrapper; checking for the slug-rendered page + the figure HTML
  // confirms the markdown round-tripped correctly.
  const res = await page.request.get(`/${slug}`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('<title>e2e flow');
  expect(html).toMatch(/class="[^"]*rkr-figure/);
});

// Image-edit pipeline coverage: rotate (a runEdit path) writes through
// the canvas pipeline + setStatus, then Save commits ops + bake to
// /admin/sidecar/:id. Targets image-edit.ts (saveImageEdits) and the
// runEdit/refreshAfterEdit glue in main.ts.
test('editor: rotate single image then save edits', async ({ page }) => {
  await login(page);

  await page.locator('#rkr-title').fill('e2e rotate');
  await page.locator('#rkr-slug').fill(`e2e-rotate-${Date.now()}`);

  // Insert a single image so the image-edit section reveals (it only
  // shows when the figure has exactly one id).
  await page.locator('#rkr-image-input').setInputFiles({
    name: 'rotate.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_RED, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded rotate\.png/, {
    timeout: 10_000
  });
  await expect(page.locator('#rkr-image-edit')).toBeVisible();

  // Wait for ensureLocalState() to settle — the Save button starts
  // disabled and the rotate handler reads getLocalEditState which
  // returns null until the meta fetch resolves.
  await expect(page.locator('#rkr-image-save-btn')).toBeDisabled();
  await expect(page.locator('#rkr-image-edits')).toBeAttached();

  await page.locator('#rkr-image-rotate-r-btn').click();
  // setStatus(`${label} ${id.slice(0,8)}…`) from refreshAfterEdit.
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^rotate /, {
    timeout: 5_000
  });
  // Op landed → Save button is now enabled (isDirty true).
  await expect(page.locator('#rkr-image-save-btn')).toBeEnabled();
  // Steps list shows one entry now.
  await expect(page.locator('#rkr-image-edits li')).toHaveCount(1);

  await page.locator('#rkr-image-save-btn').click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^saved edits /, {
    timeout: 10_000
  });
  // After save, baseline matches local → Save button disables again.
  await expect(page.locator('#rkr-image-save-btn')).toBeDisabled();
});

// Cropper modal coverage: the crop button opens a <dialog> with
// cropperjs mounted. We don't drive an actual crop — the test confirms
// the modal opens (regression-guards the cropper-modal.ts extraction)
// and that Cancel closes it without mutating the ops list.
test('editor: cropper modal opens and cancels cleanly', async ({ page }) => {
  await login(page);

  await page.locator('#rkr-title').fill('e2e crop');
  await page.locator('#rkr-slug').fill(`e2e-crop-${Date.now()}`);

  await page.locator('#rkr-image-input').setInputFiles({
    name: 'crop.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_BLUE, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded crop\.png/, {
    timeout: 10_000
  });
  await expect(page.locator('#rkr-image-edit')).toBeVisible();

  // Modal starts closed (no `open` attribute → not visible).
  const dialog = page.locator('#rkr-crop-modal');
  await expect(dialog).toBeHidden();

  // PNG_1X1_BLUE is unique to this test → fresh content-hashed id →
  // sidecar has no prior ops. The edits list is reliably empty here,
  // not racy with ensureLocalState's resolution like it was when all
  // tests shared one PNG.
  await expect(page.locator('#rkr-image-edits li')).toHaveCount(0);

  await page.locator('#rkr-image-crop-btn').click();
  // openCropper is async (loads original, bakes a stage blob, mounts
  // cropperjs); the dialog.showModal() call is the last step. Wait for
  // it via the visibility check.
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  // The cropper's status text gets set to `${w}×${h} current` once
  // mounted; wait for it as an extra signal that cropperjs initialised
  // without throwing.
  await expect(page.locator('#rkr-crop-status')).toContainText(/×/, { timeout: 5_000 });

  await page.locator('#rkr-crop-cancel').click();
  await expect(dialog).toBeHidden();

  // Cancel must not have appended an op — list stays empty.
  await expect(page.locator('#rkr-image-edits li')).toHaveCount(0);
  await expect(page.locator('#rkr-image-save-btn')).toBeDisabled();
});
