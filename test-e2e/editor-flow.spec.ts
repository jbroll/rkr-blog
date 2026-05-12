// End-to-end coverage for the editor's image flow:
//   1. Insert image  → POST /admin/upload + figure node inserted
//   2. Set matrix    → ::figure attrs panel writes through to the doc
//   3. Save          → POST /admin/posts persists markdown for /:slug
//
// The unit tests cover each route in isolation; this spec exercises the
// browser glue (TipTap insertContent, panel re-population on selection,
// JSON-to-markdown serialization on save) that only runs in a real DOM.

import sharp from 'sharp';

import { expect, test } from './coverage-fixtures.ts';

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
const PNG_1X1_GREEN =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC';
const PNG_1X1_YELLOW =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4/58BAAT/Af9dfQKHAAAAAElFTkSuQmCC';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  // Post-login redirects to the public index; callers that need the
  // editor mount follow up with their own page.goto('/admin/editor').
  await Promise.all([
    page.waitForURL((url) => new URL(url).pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
}

// The slug input is `type="hidden"` (the admin doesn't need to see or
// edit it — the server slugifies the title). Playwright's .fill()
// requires a visible element, so tests that need to pin a specific
// slug write the value via evaluate().
/** Flip a saved post's status to 'published' via the new
 * /admin/posts/:slug/status endpoint (the editor no longer carries a
 * status select). The route 303-redirects to /admin/posts on success;
 * Playwright follows the redirect so we accept 200 as well. */
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

// Poll OPFS until any file under `dir` contains `needle`. Replaces
// `waitForTimeout(<debounce + margin>)` for draft / image-state
// persistence: a timeout-based wait is brittle on a loaded CI
// runner; this polls for the actual state we care about.
async function waitForOpfsContains(
  page: import('@playwright/test').Page,
  dir: string,
  needle: string,
  timeout = 5_000
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
          async ({ d, n }: { d: string; n: string }) => {
            try {
              const root = await navigator.storage.getDirectory();
              const handle = await root.getDirectoryHandle(d);
              const iter = (
                handle as FileSystemDirectoryHandle & {
                  entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
                }
              ).entries();
              for await (const [name, h] of iter) {
                if (!name.endsWith('.json') || h.kind !== 'file') continue;
                const file = await (h as FileSystemFileHandle).getFile();
                const text = await file.text();
                if (text.includes(n)) return true;
              }
              return false;
            } catch {
              return false;
            }
          },
          { d: dir, n: needle }
        ),
      { timeout }
    )
    .toBe(true);
}

test('editor: insert image, set matrix, save publishes to /:slug', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  await page.locator('#rkr-title').fill('e2e flow');
  await page.locator('#rkr-subtitle').fill('a subtitle for the e2e test');
  // Unique slug — the e2e site root persists for the run, so reusing one
  // would surface a "already exists" save error.
  const slug = `e2e-flow-${Date.now()}`;
  await setSlug(page, slug);
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

  // The figure node now lives in the editor. The figure-config gear
  // button is rendered inside the figure body alongside +Add image.
  await expect(page.locator('button[data-figure-config]')).toBeVisible();
  // The hidden 'ids' field is populated from the upload result on
  // selection-update; a non-empty value confirms the round-trip from
  // /admin/upload landed.
  await expect(page.locator('#rkr-figure-ids')).not.toHaveValue('');

  // ---- 2. set matrix ---------------------------------------------------

  // Open the figure-config dialog and set Layout = Grid 1×2 (diptych).
  // The matrix control is the radio + spinbox panel; the wire format
  // is still the same `1x2` string the server expects. The cols
  // spinbox change-fires on blur, which the commit listener picks up.
  await page.locator('button[data-figure-config]').click();
  await expect(page.locator('#rkr-figure-dialog')).toBeVisible();
  await expect(page.locator('input[name="rkr-matrix-mode"][value="grid"]')).toBeChecked();
  await page.locator('#rkr-matrix-cols').fill('2');
  await page.locator('#rkr-matrix-cols').blur();
  await page.locator('#rkr-figure-dialog .rkr-cell-dialog-close').click();
  await expect(page.locator('#rkr-figure-dialog')).not.toBeVisible();

  // h1 is the mode label ("New post" until the post has a slug,
  // "Edit post" afterwards); tab title shows the actual post title
  // with a "● " prefix while the editor is dirty for at-a-glance
  // findability.
  await expect(page.locator('#rkr-page-title')).toHaveText('New post');
  await expect(page).toHaveTitle(/^● e2e flow/);
  // Site head renders the configured title as the home link — same
  // affordance the public chrome uses, no editor-specific back link
  // any more.
  await expect(page.locator('.rkr-site-title a[href="/"]')).toBeVisible();

  // ---- 3. save ---------------------------------------------------------

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(`saved /${slug}`, {
    timeout: 10_000
  });
  // Status carries a permalink and the dirty dot clears from the tab.
  await expect(
    page.locator('#rkroll-admin-status').getByRole('link', { name: 'view →' })
  ).toHaveAttribute('href', `/${slug}`);
  await expect(page).toHaveTitle(/^e2e flow/);

  // ---- verify the post is reachable on the public site ----------------

  // The editor saves as draft by default; the per-row status flip on
  // /admin/posts is the publish gesture. Drive it directly here so
  // /:slug renders publicly.
  await publishSlug(page, slug);
  // The figure markdown directive becomes a <figure class="rkr-figure">
  // wrapper; checking for the slug-rendered page + the figure HTML
  // confirms the markdown round-tripped correctly.
  const res = await page.request.get(`/${slug}`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('<title>e2e flow');
  expect(html).toMatch(/class="[^"]*rkr-figure/);
  // Subtitle round-trips through frontmatter → render.
  expect(html).toContain('a subtitle for the e2e test');
  expect(html).toMatch(/class="rkr-post-subtitle"/);
});

// Regression: after a local-first upload, drainUpload completes
// quickly and onAfterDrainEmpty triggers runEviction. Without the
// live-refs guard in src/admin/eviction.ts, the planner sees the
// new id as an orphan (the 500ms draft-persist debounce hasn't
// fired yet so meta/<draft>.json refIds is stale) and deletes the
// OPFS original. The figure's <img> blob: URL then dangles.
test('editor: just-inserted original survives the post-drain eviction pass', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  await page.locator('#rkr-title').fill('e2e eviction race');
  await setSlug(page, `e2e-eviction-${Date.now()}`);

  await page.locator('#rkr-image-input').setInputFiles({
    name: 'evict.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_BLACK, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded evict\.png/, {
    timeout: 10_000
  });

  // Capture the id before drain runs — the hash is content-derived
  // (PNG_1X1_BLACK) but reading off the live <img data-id> avoids
  // pinning the test to a hash literal that would drift with bytes.
  const thumb = page.locator('img[data-cell-index="0"]');
  const id = await thumb.getAttribute('data-id');
  expect(id).toBeTruthy();

  // Generous wait so drain + onAfterDrainEmpty + runEviction can
  // all complete. Drain on localhost is sub-100ms; the 500ms
  // draft-persist debounce on top is what makes the race observable.
  // Wait 1.5s so the post-drain eviction has definitely fired.
  await page.waitForTimeout(1500);

  // The OPFS original for this id must still exist; eviction would
  // have deleted it without the live-refs guard.
  const originalSurvives = await page.evaluate(async (lookupId) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('originals').catch(() => null);
    if (!dir) return false;
    const iter = (
      dir as FileSystemDirectoryHandle & {
        entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
      }
    ).entries();
    for await (const [name] of iter) {
      if (name.startsWith(`${lookupId}.`)) return true;
    }
    return false;
  }, id);
  expect(originalSurvives).toBe(true);

  // And the figure's thumb is still a blob: URL — not a /admin/preview/
  // (which would mean we fell back to the server, masking the bug).
  await expect(thumb).toHaveAttribute('src', /^blob:/);
});

// Image-edit pipeline coverage: rotate (a runEdit path) writes through
// the canvas pipeline + setStatus, then Save commits ops + bake to
// /admin/sidecar/:id. Targets image-edit.ts (saveImageEdits) and the
// runEdit/refreshAfterEdit glue in main.ts.
test('editor: rotate single image then save edits', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  await page.locator('#rkr-title').fill('e2e rotate');
  await setSlug(page, `e2e-rotate-${Date.now()}`);

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
  // Click the image to enter per-cell mode (image-edit panel only
  // reveals when a cell is explicitly selected — single-image
  // figures no longer auto-select cell 0).
  await page.locator('img[data-cell-index="0"]').click();
  await expect(page.locator('#rkr-image-edit')).toBeVisible();
  // Wait for ensureLocalState() to land before any rotate/crop click
  // — getLocalEditState (sync) returns null until the meta fetch
  // resolves, and silent no-ops here turn into flaky e2e timeouts.
  await expect(page.locator('#rkr-image-edit')).toHaveAttribute('data-ready', 'true');

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
  await page.goto('/admin/editor');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  await page.locator('#rkr-title').fill('e2e crop');
  await setSlug(page, `e2e-crop-${Date.now()}`);

  await page.locator('#rkr-image-input').setInputFiles({
    name: 'crop.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_BLUE, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded crop\.png/, {
    timeout: 10_000
  });
  // Click the image to enter per-cell mode (image-edit panel only
  // reveals when a cell is explicitly selected).
  await page.locator('img[data-cell-index="0"]').click();
  await expect(page.locator('#rkr-image-edit')).toBeVisible();
  // Wait for ensureLocalState() to land before any rotate/crop click
  // — getLocalEditState (sync) returns null until the meta fetch
  // resolves, and silent no-ops here turn into flaky e2e timeouts.
  await expect(page.locator('#rkr-image-edit')).toHaveAttribute('data-ready', 'true');

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

// After a crop is applied, the editor's <img> thumb should swap from
// /admin/preview/<id> to a blob: URL produced by the canvas pipeline
// (canvas-loaders refreshImagePreview → setEditorImageSrc). The
// reporter sees no visual change after crop, suggesting either the
// pipeline isn't running or the <img> isn't being updated.
test('editor: crop save updates the thumb src to a blob URL', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await page.locator('#rkr-title').fill('e2e crop preview');
  await setSlug(page, `e2e-crop-preview-${Date.now()}`);

  // Use a slightly larger image so the cropper has room to operate.
  const PNG_4X4 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 4;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#1a4f7f';
      ctx.fillRect(0, 0, 4, 4);
    }
    return c.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  });
  await page.locator('#rkr-image-input').setInputFiles({
    name: 'crop-preview.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_4X4, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded crop-preview/, {
    timeout: 10_000
  });

  // Pre-state: uploadImage is local-first, so hydrateLocalThumb has
  // already swapped the thumb to a blob: URL backed by the OPFS
  // original. After crop, the canvas pipeline produces a NEW blob
  // URL (the rectified bytes), so the assertion is "different blob
  // URL", not "blob URL replaces /admin/preview".
  const thumb = page.locator('img[data-cell-index="0"]');
  const beforeSrc = await thumb.getAttribute('src');
  expect(beforeSrc).toMatch(/^blob:/);

  // Open the per-cell dialog + cropper.
  await thumb.click();
  await expect(page.locator('#rkr-image-edit')).toHaveAttribute('data-ready', 'true');
  await page.locator('#rkr-image-crop-btn').click();
  const dialog = page.locator('#rkr-crop-modal');
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#rkr-crop-status')).toContainText(/×/, { timeout: 5_000 });

  // Save the crop. cropper's autoCropArea:1 means a full-extent crop
  // is auto-selected; the save commits whatever's there as an op.
  await page.locator('#rkr-crop-save').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^crop /, { timeout: 5_000 });
  await expect(page.locator('#rkr-image-edits li')).toHaveCount(1);

  // Post-state: thumb src is a *different* blob: URL — the canvas
  // pipeline produced a new bake for the cropped bytes.
  await expect.poll(async () => thumb.getAttribute('src'), { timeout: 5_000 }).not.toBe(beforeSrc);
  const afterSrc = await thumb.getAttribute('src');
  expect(afterSrc).toMatch(/^blob:/);
});

// Per-cell editing in a multi-image figure: the image-edit panel should
// hide on a fresh multi-image selection (no cell active), reveal when
// the author clicks a thumb, and target that cell's id on subsequent
// rotate / crop / save actions.
//
// Constructing a multi-image figure through the UI alone is awkward —
// the Gallery button uses a transient <input> element Playwright can't
// reach by selector. Instead we upload two distinct images via the
// single-image path, then use the editor's e2e hook (window.__rkrEditor,
// gated on ?e2e=1) to merge the two into one multi-image figure.
test('editor: per-cell selection drives the image-edit panel for multi-image figures', async ({
  page
}) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  await page.locator('#rkr-title').fill('e2e per-cell');
  await setSlug(page, `e2e-percell-${Date.now()}`);

  // Upload two distinct PNGs. cellA uses BLUE (matches the cropper
  // test which only opens-and-cancels — leaves no ops). cellB uses
  // GREEN (a fresh id, not touched by any other test) so its sidecar
  // baseline starts empty and the rotate-then-save assertions are
  // deterministic.
  await page.locator('#rkr-image-input').setInputFiles({
    name: 'cellA.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_BLUE, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded cellA\.png/, {
    timeout: 10_000
  });
  const idA = await page.locator('#rkr-figure-ids').inputValue();
  expect(idA).toMatch(/^[0-9a-f]{8,}/);

  // Move cursor past the first figure before inserting the second so
  // they don't overwrite. ProseMirror's End key + Enter gives a fresh
  // paragraph below the atom node.
  await page.locator('#rkroll-admin-article').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');

  await page.locator('#rkr-image-input').setInputFiles({
    name: 'cellB.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_GREEN, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded cellB\.png/, {
    timeout: 10_000
  });
  const idB = await page.locator('#rkr-figure-ids').inputValue();
  expect(idB).toMatch(/^[0-9a-f]{8,}/);
  expect(idB).not.toBe(idA);

  // Merge: delete the second figure, then update the first to carry
  // both ids in 1×2 matrix mode. The hook exposes the editor instance
  // when ?e2e=1.
  await page.evaluate(
    ({ a, b }: { a: string; b: string }) => {
      const ed = (window as unknown as { __rkrEditor?: import('@tiptap/core').Editor }).__rkrEditor;
      if (!ed) throw new Error('window.__rkrEditor not exposed; ?e2e=1 missing');
      // Walk the doc, find the two figure nodes, remember their positions.
      const positions: number[] = [];
      ed.state.doc.descendants((node, pos) => {
        if (node.type.name === 'figure') positions.push(pos);
      });
      if (positions.length !== 2) throw new Error(`expected 2 figures, found ${positions.length}`);
      const [firstPos, secondPos] = positions as [number, number];
      // Delete from highest pos down so the first pos stays valid.
      ed.chain()
        .focus()
        .deleteRange({ from: secondPos, to: secondPos + 1 })
        .setNodeSelection(firstPos)
        .updateAttributes('figure', { ids: `${a},${b}`, matrix: '1x2' })
        .run();
    },
    { a: idA, b: idB }
  );

  // The figure now has ids="A,B". The figure-config gear is the only
  // surfaced affordance until a cell is clicked; neither dialog is
  // open yet.
  await expect(page.locator('button[data-figure-config]')).toBeVisible();
  await expect(page.locator('#rkr-figure-ids')).toHaveValue(`${idA},${idB}`);
  await expect(page.locator('#rkr-cell-dialog')).not.toBeVisible();

  // Click the second thumb (data-cell-index="1"). Per-image dialog
  // opens scoped to that cell's id.
  await page.locator('img[data-cell-index="1"]').click();
  await expect(page.locator('#rkr-image-edit')).toBeVisible();
  await expect(page.locator('img[data-cell-index="1"]')).toHaveClass(/is-active-cell/);

  // Rotate the second cell. Status reports the cell's id prefix.
  await page.locator('#rkr-image-rotate-r-btn').click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(
    new RegExp(`^rotate ${idB.slice(0, 8)}`),
    { timeout: 5_000 }
  );
  await expect(page.locator('#rkr-image-edits li')).toHaveCount(1);
  await expect(page.locator('#rkr-image-save-btn')).toBeEnabled();

  // Save commits to the second cell's sidecar specifically.
  await page.locator('#rkr-image-save-btn').click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(
    new RegExp(`^saved edits ${idB.slice(0, 8)}`),
    { timeout: 10_000 }
  );

  // Switch to the first cell. The per-image controls live in a modal
  // dialog now, so we close the current dialog before clicking the
  // next cell (the modal's backdrop blocks pass-through clicks by
  // design — one image at a time). The first cell's panel shows the
  // empty state (no ops applied yet), distinct from the second cell.
  await page.locator('#rkr-cell-dialog .rkr-cell-dialog-close').click();
  await expect(page.locator('#rkr-cell-dialog')).not.toBeVisible();
  await page.locator('img[data-cell-index="0"]').click();
  await expect(page.locator('#rkr-cell-dialog')).toBeVisible();
  await expect(page.locator('img[data-cell-index="0"]')).toHaveClass(/is-active-cell/);
  await expect(page.locator('img[data-cell-index="1"]')).not.toHaveClass(/is-active-cell/);
  await expect(page.locator('#rkr-image-edits li')).toHaveCount(0);
  await expect(page.locator('#rkr-image-save-btn')).toBeDisabled();
});

// "Remove image from figure" in the per-cell dialog. Removes the
// active cell's id from the figure's ids/alts/captions arrays after a
// confirm prompt. Image bytes + sidecar stay on disk; only the
// figure's reference is dropped.
test('editor: per-cell delete removes one image from a multi-image figure', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await page.locator('#rkr-title').fill('e2e per-cell delete');
  await setSlug(page, `e2e-percell-del-${Date.now()}`);

  // Same setup as the per-cell test: upload two distinct PNGs, merge
  // into one figure with two cells in 1×2 mode.
  await page.locator('#rkr-image-input').setInputFiles({
    name: 'delA.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_BLUE, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded delA\.png/, {
    timeout: 10_000
  });
  const idA = await page.locator('#rkr-figure-ids').inputValue();

  await page.locator('#rkroll-admin-article').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.locator('#rkr-image-input').setInputFiles({
    name: 'delB.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_GREEN, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded delB\.png/, {
    timeout: 10_000
  });
  const idB = await page.locator('#rkr-figure-ids').inputValue();
  expect(idB).not.toBe(idA);

  await page.evaluate(
    ({ a, b }: { a: string; b: string }) => {
      const ed = (window as unknown as { __rkrEditor?: import('@tiptap/core').Editor }).__rkrEditor;
      if (!ed) throw new Error('window.__rkrEditor not exposed; ?e2e=1 missing');
      const positions: number[] = [];
      ed.state.doc.descendants((node, pos) => {
        if (node.type.name === 'figure') positions.push(pos);
      });
      const [firstPos, secondPos] = positions as [number, number];
      ed.chain()
        .focus()
        .deleteRange({ from: secondPos, to: secondPos + 1 })
        .setNodeSelection(firstPos)
        .updateAttributes('figure', { ids: `${a},${b}`, alts: 'alpha,beta', matrix: '1x2' })
        .run();
    },
    { a: idA, b: idB }
  );
  await expect(page.locator('#rkr-figure-ids')).toHaveValue(`${idA},${idB}`);

  // Open the per-cell dialog for the second cell. Accept the confirm
  // prompt that fires on the delete click.
  await page.locator('img[data-cell-index="1"]').click();
  await expect(page.locator('#rkr-cell-dialog')).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await page.locator('#rkr-cell-delete-btn').click();

  // Dialog closes; the figure's ids + alts collapse to just the first
  // cell's slot. Read via the editor hook directly: the hidden
  // #rkr-figure-ids input is a mirror populated on selectionUpdate,
  // which doesn't necessarily fire after a setNodeMarkup transaction.
  // The editor's own attrs are the source of truth.
  await expect(page.locator('#rkr-cell-dialog')).not.toBeVisible();
  const after = await page.evaluate(() => {
    const ed = (window as unknown as { __rkrEditor?: import('@tiptap/core').Editor }).__rkrEditor;
    const a = ed?.getAttributes('figure') as { ids?: string; alts?: string } | undefined;
    return { ids: a?.ids ?? '', alts: a?.alts ?? '' };
  });
  expect(after.ids).toBe(idA);
  expect(after.alts).toBe('alpha');
});

// Per-cell delete: declining the confirm prompt must be a no-op (the
// figure's ids stay intact). Defends against the destructive action
// firing on a misclick that the author then cancels at the prompt.
test('editor: per-cell delete is a no-op when confirm is declined', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await page.locator('#rkr-title').fill('e2e percell del-cancel');
  await setSlug(page, `e2e-percell-delcancel-${Date.now()}`);

  // Single-image figure — enough to surface the delete button via the
  // per-cell dialog. (The "cell" is just cell-index=0.)
  await page.locator('#rkr-image-input').setInputFiles({
    name: 'cancel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_BLUE, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded cancel\.png/, {
    timeout: 10_000
  });
  const id = await page.locator('#rkr-figure-ids').inputValue();
  expect(id).toMatch(/^[0-9a-f]{8,}/);

  await page.locator('img[data-cell-index="0"]').click();
  await expect(page.locator('#rkr-cell-dialog')).toBeVisible();
  page.once('dialog', (d) => void d.dismiss());
  await page.locator('#rkr-cell-delete-btn').click();

  // Dialog stays open; figure ids unchanged (read editor state, not
  // the hidden mirror).
  await expect(page.locator('#rkr-cell-dialog')).toBeVisible();
  const after = await page.evaluate(() => {
    const ed = (window as unknown as { __rkrEditor?: import('@tiptap/core').Editor }).__rkrEditor;
    return (ed?.getAttributes('figure') as { ids?: string } | undefined)?.ids ?? '';
  });
  expect(after).toBe(id);
});

// Figure-level delete: the trash icon in the figure's right-edge
// action stack removes the whole figure node from the doc after a
// confirm. Image bytes + sidecars stay on disk — only the post's
// ::figure block is dropped.
test('editor: figure delete removes the whole figure node from the doc', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await page.locator('#rkr-title').fill('e2e figure delete');
  await setSlug(page, `e2e-figdel-${Date.now()}`);

  await page.locator('#rkr-image-input').setInputFiles({
    name: 'figdel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_BLUE, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded figdel\.png/, {
    timeout: 10_000
  });
  // Pre-state: the doc has exactly one figure.
  const figuresBefore = await page.evaluate(() => {
    const ed = (window as unknown as { __rkrEditor?: import('@tiptap/core').Editor }).__rkrEditor;
    let count = 0;
    ed?.state.doc.descendants((node) => {
      if (node.type.name === 'figure') count++;
    });
    return count;
  });
  expect(figuresBefore).toBe(1);

  page.once('dialog', (d) => void d.accept());
  await page.locator('button[data-figure-delete]').click();

  // Post-state: the figure is gone. Read via __rkrEditor since the
  // figure dialog / hidden #rkr-figure-ids mirror no longer applies.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const ed = (window as unknown as { __rkrEditor?: import('@tiptap/core').Editor })
          .__rkrEditor;
        let count = 0;
        ed?.state.doc.descendants((node) => {
          if (node.type.name === 'figure') count++;
        });
        return count;
      })
    )
    .toBe(0);
});

// Figure-level delete cancel: declining the confirm leaves the
// figure untouched.
test('editor: figure delete is a no-op when confirm is declined', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await page.locator('#rkr-title').fill('e2e figdel cancel');
  await setSlug(page, `e2e-figdel-cancel-${Date.now()}`);

  await page.locator('#rkr-image-input').setInputFiles({
    name: 'figdel-cancel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_BLUE, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded figdel-cancel\.png/, {
    timeout: 10_000
  });

  page.once('dialog', (d) => void d.dismiss());
  await page.locator('button[data-figure-delete]').click();

  const figuresAfter = await page.evaluate(() => {
    const ed = (window as unknown as { __rkrEditor?: import('@tiptap/core').Editor }).__rkrEditor;
    let count = 0;
    ed?.state.doc.descendants((node) => {
      if (node.type.name === 'figure') count++;
    });
    return count;
  });
  expect(figuresAfter).toBe(1);
});

// Source-picker entry points: the toolbar's +Image button and each
// figure's "+ Add image" button both route through the same picker
// dialog. The Local branch sets pendingInsertMode (new vs append)
// before triggering fileInput.click(), so the persistent change
// listener can branch on insert-vs-append. e2e setInputFiles bypasses
// the dialog entirely (the "main flow" tests above), so this spec
// specifically exercises the dialog→Local→fileInput chain.
test('editor: source picker drives both +Image (new) and figure + (append)', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  await page.locator('#rkr-title').fill('e2e picker');
  await setSlug(page, `e2e-picker-${Date.now()}`);

  const dialog = page.locator('#rkr-source-picker');

  // ---- 1. Toolbar +Image → Local: opens dialog, picks local source,
  //         setInputFiles delivers the file, change listener inserts
  //         a NEW figure (default mode).
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '+Image', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.locator('button[data-source="local"]').click();
  await expect(dialog).toBeHidden();

  await page.locator('#rkr-image-input').setInputFiles({
    name: 'first.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_BLACK, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded first\.png/, {
    timeout: 10_000
  });
  const idA = await page.locator('#rkr-figure-ids').inputValue();
  expect(idA).toMatch(/^[0-9a-f]{8,}/);

  // ---- 2. Figure "+ Add image" → Local: opens the same dialog,
  //         this time pendingInsertMode='append' is stashed, so the
  //         change listener appends to the active figure's ids.
  await page.locator('button[data-add-image]').click();
  await expect(dialog).toBeVisible();
  await dialog.locator('button[data-source="local"]').click();
  await expect(dialog).toBeHidden();

  await page.locator('#rkr-image-input').setInputFiles({
    name: 'second.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_RED, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(
    /^appended 1 image\(s\) to figure/,
    { timeout: 10_000 }
  );
  // The figure now carries both ids. Read via the e2e __rkrEditor
  // hook because the hidden #rkr-figure-ids input is only refreshed
  // when a figure is selected — the dialog focus dance during append
  // can leave the editor unfocused even though the doc state updated.
  const figureIds = await page.evaluate(() => {
    const ed = (window as unknown as { __rkrEditor?: import('@tiptap/core').Editor }).__rkrEditor;
    if (!ed) throw new Error('window.__rkrEditor not exposed');
    let ids = '';
    ed.state.doc.descendants((node) => {
      if (node.type.name === 'figure') ids = String((node.attrs as { ids: string }).ids ?? '');
    });
    return ids;
  });
  expect(figureIds.split(',').length).toBe(2);
  expect(figureIds.startsWith(`${idA},`)).toBe(true);

  // ---- 3. Cancel branch: dialog opens, Cancel closes it with no
  //         further side effect (mode remains 'new' for the next
  //         direct setInputFiles).
  await page.getByRole('button', { name: '+Image', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.locator('button[data-source=""]').click();
  await expect(dialog).toBeHidden();
});

// Offline upload flow (phase 1f): with the browser context offline,
// uploadImage's POST fails, queueUpload writes the original to OPFS
// + appends an `upload` outbox entry, returning a synthetic
// UploadResponse so the figure node is inserted immediately. Going
// back online re-fires sync.tryDrain via the online-state change
// subscription in startup.ts; the upload drainer POSTs the queued
// blob and the entry is removed.
test('editor: offline upload queues + drains on reconnect', async ({ page, context }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  await page.locator('#rkr-title').fill('e2e offline');
  await setSlug(page, `e2e-offline-${Date.now()}`);

  // ---- 1. go offline + upload --------------------------------------
  await context.setOffline(true);

  // PNG_1X1_PURPLE — unique to this test so the content-hashed id is
  // fresh and prior-test sidecar state doesn't bleed.
  const PNG_1X1_PURPLE =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR4nGNgYPj/HwACBwIAyTrtSAAAAABJRU5ErkJggg==';
  await page.locator('#rkr-image-input').setInputFiles({
    name: 'offline-pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_PURPLE, 'base64')
  });

  // uploadImage returns the same UploadResponse shape online or
  // offline; the editor's status line still reports "uploaded …".
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded offline-pixel\.png/, {
    timeout: 10_000
  });

  await expect(page.locator('button[data-figure-config]')).toBeVisible();
  const id = await page.locator('#rkr-figure-ids').inputValue();
  expect(id).toMatch(/^[0-9a-f]{64}$/);

  // ---- 2. go back online + verify the queued upload drains --------
  await context.setOffline(false);
  // Playwright's setOffline(false) doesn't fire window.online by
  // itself; dispatch the event so startup.ts's onOnlineChange
  // subscription triggers tryDrain.
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
  });

  // The drainer POSTs to /admin/upload; on success the outbox entry
  // is removed. /admin/preview returns 302 only when the server has
  // a sidecar for the id — proves the bytes round-tripped.
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/admin/preview/${id}`, { maxRedirects: 0 });
        return res.status();
      },
      { timeout: 15_000 }
    )
    .toBe(302);
});

// Offline edit-and-save flow (phase 1f): upload while online so the
// id is real on the server, then go offline and apply rotate + Save
// edits. commitOffline appends setOps + bake outbox entries; drainers
// post them on reconnect.
test('editor: offline rotate+save queues setOps+bake, drains on reconnect', async ({
  page,
  context
}) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  await page.locator('#rkr-title').fill('e2e offline edit');
  await setSlug(page, `e2e-offlineedit-${Date.now()}`);

  // Unique PNG to keep this test's sidecar state clean (cyan).
  const PNG_1X1_CYAN =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR4nGNgYPj/HwAEAQH/MQyKoQAAAABJRU5ErkJggg==';
  await page.locator('#rkr-image-input').setInputFiles({
    name: 'edit-pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_CYAN, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded edit-pixel\.png/, {
    timeout: 10_000
  });
  const id = await page.locator('#rkr-figure-ids').inputValue();
  expect(id).toMatch(/^[0-9a-f]{64}$/);

  // Enter per-cell mode while still online so ensureLocalState's
  // initial meta fetch lands; otherwise rotate fires before the local
  // state hydrates and the op silently drops.
  await page.locator('img[data-cell-index="0"]').click();
  await expect(page.locator('#rkr-image-edit')).toBeVisible();
  // Wait for ensureLocalState() to land before any rotate/crop click
  // — getLocalEditState (sync) returns null until the meta fetch
  // resolves, and silent no-ops here turn into flaky e2e timeouts.
  await expect(page.locator('#rkr-image-edit')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#rkr-image-save-btn')).toBeDisabled();

  // ---- 1. go offline + rotate + save -------------------------------
  await context.setOffline(true);
  // Tell the SPA we're offline so getState() flips before Save fires.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));

  await page.locator('#rkr-image-rotate-r-btn').click();
  await expect(page.locator('#rkr-image-edits li')).toHaveCount(1);
  await expect(page.locator('#rkr-image-save-btn')).toBeEnabled();

  await page.locator('#rkr-image-save-btn').click();
  // commitOffline updates s.baseline → Save disables again.
  await expect(page.locator('#rkr-image-save-btn')).toBeDisabled({ timeout: 10_000 });

  // Confirm the server STILL doesn't see the rotate op yet.
  const metaPre = await page.request.get(`/admin/sidecar/${id}/meta`);
  expect(metaPre.status()).toBe(200);
  const metaPreBody = await metaPre.json();
  expect(metaPreBody.ops).toEqual([]);

  // ---- 2. reconnect + drain ----------------------------------------
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  // Once the drainers run (setOps then bake), the server's sidecar
  // carries the rotate op.
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/admin/sidecar/${id}/meta`);
        if (!res.ok()) return null;
        const body = (await res.json()) as { ops: { type: string; degrees?: number }[] };
        return body.ops;
      },
      { timeout: 15_000 }
    )
    .toEqual([{ type: 'rotate', degrees: 90 }]);
});

// Offline post-save flow (phase 1g): compose a fresh post while
// offline, click Save → handleSave queues a `savePost` outbox entry
// rather than POSTing. On reconnect, drainSavePost posts /admin/posts
// and /:slug then renders the post.
test('editor: offline savePost queues + drains on reconnect to publish /:slug', async ({
  page,
  context
}) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  const slug = `e2e-offline-save-${Date.now()}`;
  await page.locator('#rkr-title').fill('e2e offline save');
  await setSlug(page, slug);

  // Type a one-line body so the post has visible content on /:slug.
  await page.evaluate(() => {
    const ed = (
      window as unknown as { __rkrEditor: { commands: { setContent: (s: string) => void } } }
    ).__rkrEditor;
    ed.commands.setContent('<p>offline save body</p>');
  });

  // ---- 1. go offline + Save ---------------------------------------
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(`queued /${slug} for sync`, {
    timeout: 10_000
  });

  // Confirm the server has NOT received the post yet.
  const preStatus = (await page.request.get(`/${slug}`, { maxRedirects: 0 })).status();
  expect(preStatus).toBe(404);

  // ---- 2. reconnect + drain ---------------------------------------
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));

  // drainSavePost lands the post as draft (the editor doesn't
  // carry status); flip to published so /:slug becomes reachable.
  // Wait for the file to land first — the publish endpoint 404s
  // until the drainer's POST hits the server.
  await expect
    .poll(async () => (await page.request.get(`/admin/post-bundle/${slug}?manifest=1`)).status(), {
      timeout: 15_000
    })
    .toBe(200);
  await publishSlug(page, slug);
  await expect
    .poll(async () => (await page.request.get(`/${slug}`, { maxRedirects: 0 })).status(), {
      timeout: 15_000
    })
    .toBe(200);

  const html = await (await page.request.get(`/${slug}`)).text();
  expect(html).toContain('offline save body');
});

// Draft persistence (phase 1h): editor JSON is debounce-persisted to
// opfs://drafts/<id>.json so a tab close + reopen restores exactly
// what the author saw. Type, wait past the 500ms debounce, reload,
// confirm the text comes back.
test('editor: typed body persists across reload via OPFS draft', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  // Wait for draft restore to finish before our setContent — without
  // this, a race lets startOfflineInfrastructure clobber the test's
  // typed sentinel with whatever a prior test left in OPFS.
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );

  const sentinel = `draft persisted ${Date.now()}`;
  await page.evaluate((text) => {
    const ed = (
      window as unknown as { __rkrEditor: { commands: { setContent: (s: string) => void } } }
    ).__rkrEditor;
    ed.commands.setContent(`<p>${text}</p>`);
  }, sentinel);

  // Poll OPFS until the debounced flush has written the sentinel into
  // drafts/<id>.json. Replaces waitForTimeout(900) which flakes on
  // loaded CI runners.
  await waitForOpfsContains(page, 'drafts', sentinel);

  // Reload re-mounts the SPA; startOfflineInfrastructure restores the
  // persisted draft into the editor before user interaction.
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );

  // The restored doc should contain the sentinel paragraph in the
  // ProseMirror DOM.
  await expect(page.locator('#rkroll-admin-article')).toContainText(sentinel, { timeout: 5_000 });
});

// Image-state persistence (phase 1i): unsaved per-image edits survive
// a tab reload via opfs://image-state/<id>.json. Rotate, reload,
// re-select the figure, confirm the rotate op is still queued (Save
// button still enabled, edits list still shows it).
test('editor: unsaved image edits survive reload via OPFS image-state', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );

  // OPFS persists across e2e runs (it's tied to the origin, not the
  // browser context). Clear image-state/ so a prior run's persisted
  // ops for the same content-hashed id don't carry over.
  await page.evaluate(async () => {
    const opfs = await navigator.storage.getDirectory();
    try {
      await opfs.removeEntry('image-state', { recursive: true });
    } catch {
      /* directory absent on first run */
    }
  });

  // PNG_1X1_YELLOW — unique to this test so the content-hashed id
  // doesn't collide with PNG_1X1_GREEN (test 4 saves a rotate against
  // that id; the server sidecar carries [rotate] permanently).
  await page.locator('#rkr-image-input').setInputFiles({
    name: 'persist-edit.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_YELLOW, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded persist-edit\.png/, {
    timeout: 10_000
  });
  const id = await page.locator('#rkr-figure-ids').inputValue();

  // Enter per-cell mode by clicking the image.
  await page.locator('img[data-cell-index="0"]').click();
  await expect(page.locator('#rkr-image-edit')).toBeVisible();
  // Wait for ensureLocalState() to land before any rotate/crop click
  // — getLocalEditState (sync) returns null until the meta fetch
  // resolves, and silent no-ops here turn into flaky e2e timeouts.
  await expect(page.locator('#rkr-image-edit')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#rkr-image-save-btn')).toBeDisabled();

  await page.locator('#rkr-image-rotate-r-btn').click();
  await expect(page.locator('#rkr-image-edits li')).toHaveCount(1);
  await expect(page.locator('#rkr-image-save-btn')).toBeEnabled();
  // Poll until the draft persist (figure-insert update event flushed
  // through the debounce) has the figure id in drafts/<id>.json AND
  // the rotate op landed in image-state/<id>.json. The bare op-name
  // substring is shape-agnostic (matches both `"type":"rotate"` and
  // `"type": "rotate"` regardless of how opfs writeJson formats),
  // and image-state's initial persist after upload has empty ops, so
  // matching `rotate` proves the post-click persist completed.
  await waitForOpfsContains(page, 'drafts', id);
  await waitForOpfsContains(page, 'image-state', 'rotate');

  // ---- reload + re-select the figure ----------------------------
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );

  // Selecting the figure populates the image-edit panel; ensureLocalState
  // reads the OPFS persist before falling through to the server.
  await page.evaluate((targetId) => {
    type EditorLike = {
      state: {
        doc: {
          descendants: (
            cb: (node: { type: { name: string }; attrs: { ids?: string[] } }, pos: number) => void
          ) => void;
        };
      };
      commands: { setNodeSelection: (pos: number) => boolean };
    };
    const ed = (window as unknown as { __rkrEditor: EditorLike }).__rkrEditor;
    let figurePos = -1;
    ed.state.doc.descendants((node, pos) => {
      if (node.type.name === 'figure' && node.attrs.ids?.includes(targetId)) {
        figurePos = pos;
      }
    });
    if (figurePos < 0) throw new Error('figure not found in restored doc');
    ed.commands.setNodeSelection(figurePos);
  }, id);

  // Re-enter per-cell mode post-reload (selection restore picks the
  // figure, but activeCellIndex isn't persisted; the click brings up
  // the image-edit pipeline for cell 0).
  await page.locator('img[data-cell-index="0"]').click();
  await expect(page.locator('#rkr-image-edit')).toBeVisible();
  // Wait for ensureLocalState() to land before any rotate/crop click
  // — getLocalEditState (sync) returns null until the meta fetch
  // resolves, and silent no-ops here turn into flaky e2e timeouts.
  await expect(page.locator('#rkr-image-edit')).toHaveAttribute('data-ready', 'true');
  // Restored state has the rotate op still pending.
  await expect(page.locator('#rkr-image-edits li')).toHaveCount(1, { timeout: 5_000 });
  await expect(page.locator('#rkr-image-save-btn')).toBeEnabled();
});

// Status badge (phase 1j): bottom-right corner of #rkroll-admin-root
// reflects connectivity + pending outbox depth + drain status. The
// CSS class on .rkr-sync-dot encodes the state machine; the .rkr-sync-
// text element shows the headline.
test('editor: sync status badge reflects online/offline transitions', async ({ page, context }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );

  const badge = page.locator('#rkr-sync-badge');
  await expect(badge).toBeVisible();
  // Initial state after offlineReady resolves: online state machine
  // has settled to 'online' via the /health probe.
  await expect(badge.locator('.rkr-sync-dot')).toHaveClass(/is-online/, { timeout: 5_000 });
  await expect(badge.locator('.rkr-sync-text')).toHaveText('online');

  // Go offline → window event → online-state publishes 'offline' → badge.
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(badge.locator('.rkr-sync-dot')).toHaveClass(/is-offline/, { timeout: 3_000 });
  await expect(badge.locator('.rkr-sync-text')).toHaveText('offline');

  // Back online — recovery via the SPA's online-event handler. The
  // probe re-runs, the badge flicks to 'online'.
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(badge.locator('.rkr-sync-dot')).toHaveClass(/is-online/, { timeout: 5_000 });
});

// savePost conflict + force-overwrite (phase 1l). Save v1 online so
// the post mtime is fresh and the draft meta records lastSyncedAt.
// Then bump the file mtime via the e2e-only test endpoint so the
// next save's X-Rkr-Last-Synced-At looks stale → 409 → conflict
// status. Force-overwrite clears the conflict and the v2 markdown
// lands.
test('editor: savePost conflict surfaces + force-overwrite resolves it', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );

  const slug = `e2e-conflict-${Date.now()}`;
  await page.locator('#rkr-title').fill('e2e conflict v1');
  await setSlug(page, slug);
  await page.evaluate(() => {
    const ed = (
      window as unknown as { __rkrEditor: { commands: { setContent: (s: string) => void } } }
    ).__rkrEditor;
    ed.commands.setContent('<p>v1 body</p>');
  });

  // ---- 1. save v1 online → meta.lastSyncedAt stamped --------------
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(`saved /${slug}`, {
    timeout: 10_000
  });

  // ---- 2. competing-device write — bump mtime via the test-only
  //         endpoint so the next save's lastSyncedAt header looks stale.
  const bump = await page.request.post(`/admin/test/bump-mtime/${slug}`, {
    data: { offsetMs: 5_000 }
  });
  expect(bump.status()).toBe(200);

  // ---- 3. save v2 → 409 → conflict status -------------------------
  await page.locator('#rkr-title').fill('e2e conflict v2');
  await page.evaluate(() => {
    const ed = (
      window as unknown as { __rkrEditor: { commands: { setContent: (s: string) => void } } }
    ).__rkrEditor;
    ed.commands.setContent('<p>v2 body</p>');
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // The online attempt hits 409. handleSave's catch falls through to
  // queueSavePost — entry queued for drain. tryDrain runs immediately,
  // drainSavePost sees 409 again, throws SavePostConflictError, sync
  // publishes 'conflict'. The badge reflects it.
  const badge = page.locator('#rkr-sync-badge');
  await expect(badge.locator('.rkr-sync-dot')).toHaveClass(/is-conflict/, { timeout: 10_000 });
  await expect(badge.locator('.rkr-sync-text')).toHaveText(`conflict on /${slug}`);

  // ---- 4. force-overwrite resolves it -----------------------------
  await page.evaluate(async () =>
    (window as unknown as { __rkrForceConflict: () => Promise<void> }).__rkrForceConflict()
  );
  // Force POSTs without the header → server accepts → drainer removes
  // the entry → status returns to a non-conflict state.
  await expect(badge.locator('.rkr-sync-dot')).not.toHaveClass(/is-conflict/, { timeout: 10_000 });

  // The public site renders v2 once we publish — the editor saves
  // as draft now, with status owned by the per-row toggle on
  // /admin/posts.
  await publishSlug(page, slug);
  const html = await (await page.request.get(`/${slug}`)).text();
  expect(html).toContain('v2 body');
});

// Regression: + New post FAB must give a fresh draft, not resurrect
// whatever post was last edited. The bug: getOrCreateDraftId returns
// the existing currentDraftId from OPFS if any, so opening the editor
// without ?slug + without ?new restored the previous post's body.
// The fix is the ?new=1 querystring that startup.ts honours by
// clearing currentDraftId before getOrCreateDraftId runs.
test('editor: + New post (?new=1) starts a blank draft, not the prior one', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );

  // Seed a draft with a recognisable body — pretend the author was
  // mid-compose on some other post.
  await page.locator('#rkr-title').fill('previous draft');
  await page.evaluate(() => {
    const ed = (
      window as unknown as { __rkrEditor: { commands: { setContent: (s: string) => void } } }
    ).__rkrEditor;
    ed.commands.setContent('<p>OLD DRAFT BODY DO NOT RESTORE</p>');
  });
  // Wait until the draft has been written to OPFS so the next page
  // load can see it. Persistence debounces at 500ms.
  await waitForOpfsContains(page, 'drafts', 'OLD DRAFT BODY DO NOT RESTORE');

  // Reopen with no params — confirms the OLD draft restores
  // (sanity check on the existing default-restore behaviour).
  await page.goto('/admin/editor?e2e=1');
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );
  await expect(page.locator('#rkroll-admin-article')).toContainText(
    'OLD DRAFT BODY DO NOT RESTORE'
  );

  // Now open with ?new=1 (what the + FAB emits) — startup must
  // clear currentDraftId and the editor must mount blank.
  await page.goto('/admin/editor?new=1&e2e=1');
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );
  await expect(page.locator('#rkroll-admin-article')).not.toContainText(
    'OLD DRAFT BODY DO NOT RESTORE'
  );
  await expect(page.locator('#rkr-title')).toHaveValue('');
});

// Pin existing post for offline edit (phase 2). Seed v1 via the API,
// clear OPFS so the pin pulls fresh, then __rkrPin(slug) pulls the
// bundle, reload to mount the pinned draft, go offline + edit + Save
// (queues), reconnect → drain → /:slug renders v2.
test('editor: pin existing post → offline edit → reconnect drains', async ({ page, context }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );

  // Seed an existing post v1 via the API, with an image reference
  // so the pin bundle exercises the originals-fetch path. Upload
  // the image first so the server has the original + sidecar.
  const PNG_1X1_PIN =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQDvf9QQAAAAAElFTkSuQmCC';
  const upload = await page.request.post('/admin/upload', {
    multipart: {
      file: {
        name: 'pin-img.png',
        mimeType: 'image/png',
        buffer: Buffer.from(PNG_1X1_PIN, 'base64')
      }
    }
  });
  expect(upload.status()).toBe(200);
  const uploadBody = (await upload.json()) as { id: string };
  const slug = `e2e-pin-${Date.now()}`;
  const seed = await page.request.post('/admin/posts', {
    data: {
      slug,
      title: 'e2e pin v1',
      status: 'published',
      markdown: `pinned source body\n\n::image{#${uploadBody.id.slice(0, 8)} alt="x"}\n`
    }
  });
  expect(seed.status()).toBe(200);

  // Clear drafts/ + meta/ so __rkrPin installs into a fresh OPFS
  // slot. removeEntry recursive:true takes meta/_root.json with it;
  // the page.goto below re-runs ensureSchema, which re-creates a
  // fresh _root.json (status: 'fresh') with no currentDraftId.
  await page.evaluate(async () => {
    const opfs = await navigator.storage.getDirectory();
    for (const dir of ['drafts', 'meta']) {
      try {
        await opfs.removeEntry(dir, { recursive: true });
      } catch {
        /* absent */
      }
    }
  });
  await page.goto('/admin/editor?e2e=1');
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );

  // pinPost writes sidecars + originals + a fresh drafts/<id>.json
  // pointing at the parsed markdown, and bumps currentDraftId.
  const pinResult = await page.evaluate(async (s) => {
    const fn = (
      window as unknown as { __rkrPin: (s: string) => Promise<{ progress: { total: number } }> }
    ).__rkrPin;
    return fn(s);
  }, slug);
  expect(pinResult.progress.total).toBe(1); // the seeded image
  expect(pinResult.progress.fetched + pinResult.progress.skipped).toBe(1);

  // Reload mounts against the new draftId; startup restores the
  // pinned post body into the editor.
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );
  await expect(page.locator('#rkroll-admin-article')).toContainText('pinned source body');

  // Offline edit + queue savePost.
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.locator('#rkr-title').fill('e2e pin v2');
  await setSlug(page, slug);
  // Status was set to 'published' on the API seed above; the editor
  // no longer carries a status select and the save handler preserves
  // the existing status, so no per-save flip is needed here.
  await page.evaluate(() => {
    const ed = (
      window as unknown as { __rkrEditor: { commands: { setContent: (s: string) => void } } }
    ).__rkrEditor;
    ed.commands.setContent('<p>pinned + edited offline</p>');
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(`queued /${slug} for sync`, {
    timeout: 10_000
  });

  // Reconnect → drain → /:slug renders v2.
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`/${slug}`);
        return r.ok() && (await r.text()).includes('pinned + edited offline');
      },
      { timeout: 15_000 }
    )
    .toBe(true);
});

// Storage panel + eviction (phase 3). Open the panel, verify it
// reflects the current OPFS state (pinned post from a prior pin,
// pending queue, schema version), then exercise the "Sync now" and
// "Evict all cached" buttons.
test('editor: storage panel shows usage + sync-now + evict-all', async ({ page, context }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );

  // Seed an offline savePost so the pending list is non-empty when
  // the panel opens. Stays queued until "Sync now" drains it.
  const slug = `e2e-panel-${Date.now()}`;
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.locator('#rkr-title').fill('e2e panel');
  await setSlug(page, slug);
  await page.evaluate(() => {
    const ed = (
      window as unknown as { __rkrEditor: { commands: { setContent: (s: string) => void } } }
    ).__rkrEditor;
    ed.commands.setContent('<p>panel body</p>');
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(`queued /${slug} for sync`, {
    timeout: 10_000
  });

  // Open the panel via the e2e hook (the badge click fires the same
  // openStoragePanel; the hook lets us drive it without focusing).
  await page.evaluate(async () =>
    (window as unknown as { __rkrPanel: () => Promise<void> }).__rkrPanel()
  );
  const panel = page.locator('#rkr-storage-panel');
  await expect(panel).toBeVisible();
  // Schema version is rendered.
  await expect(panel.locator('#rkr-storage-schema')).toContainText(/^schema v\d+$/);
  // Pending queue has at least our queued savePost.
  await expect(panel.locator('#rkr-storage-pending li')).not.toHaveCount(0);

  // "Sync now" drains: go online first, then click. Drainer posts
  // /admin/posts; pending list re-renders empty.
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.locator('#rkr-storage-sync-now').click();
  await expect
    .poll(
      async () =>
        Number(await panel.locator('#rkr-storage-pending .rkr-storage-empty').count()) === 1,
      { timeout: 10_000 }
    )
    .toBe(true);

  // "Evict all cached" stamps every cached meta into the past and
  // runs eviction. With everything pinned this is mostly a no-op,
  // but the click path exercises onEvictCached + the re-render.
  await page.locator('#rkr-storage-evict-cached').click();
  await expect(panel).toBeVisible();
});

// outbox.append is read-modify-write on _root.json#nextSeq. Without
// the rkr-outbox-append Web Lock, parallel callers can collide on
// the same seq. This spec fires N appends via Promise.all and
// asserts the resulting entries have N distinct seqs.
test('outbox: parallel appends produce distinct seqs (no nextSeq race)', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );

  // Clear the outbox so prior tests' entries don't pollute the count.
  await page.evaluate(async () => {
    const opfs = await navigator.storage.getDirectory();
    for (const dir of ['outbox', 'outbox-blobs']) {
      try {
        await opfs.removeEntry(dir, { recursive: true });
      } catch {
        /* absent */
      }
    }
  });

  const n = 8;
  const seqs = await page.evaluate(async (count) => {
    type AppendFn = (entry: {
      op: 'savePost';
      payload: { slug: string; title: string; status: 'draft'; markdown: string };
    }) => Promise<number>;
    const append = (window as unknown as { __rkrOutboxAppend: AppendFn }).__rkrOutboxAppend;
    return Promise.all(
      Array.from({ length: count }, (_, i) =>
        append({
          op: 'savePost',
          payload: {
            slug: `e2e-race-${i}`,
            title: `race ${i}`,
            status: 'draft',
            markdown: `body ${i}\n`
          }
        })
      )
    );
  }, n);

  expect(seqs).toHaveLength(n);
  expect(new Set(seqs).size).toBe(n);
});

// DEFERRED 9a: figure-caption / per-cell-caption / per-cell-alt
// inputs used to fire one TipTap transaction per keystroke. The
// new attr-commit module debounces them; handleSave flushes any
// pending commit before serialising. Without the flush, a quick
// "type caption then click save" would write markdown without the
// last typed characters.
test('editor: caption typed-then-saved-fast flushes pending debounce', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  const slug = `e2e-debounce-${Date.now()}`;
  await page.locator('#rkr-title').fill('e2e debounce');
  await setSlug(page, slug);

  await page.locator('#rkr-image-input').setInputFiles({
    name: 'debounce.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_YELLOW, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded debounce/, {
    timeout: 10_000
  });

  await page.locator('button[data-figure-config]').click();
  await expect(page.locator('#rkr-figure-dialog')).toBeVisible();
  // Type the caption with `fill` (which dispatches a single input
  // event, not per-character), then immediately save. Without the
  // flush this can race with the 150ms debounce; with the flush the
  // saved markdown contains the caption.
  const caption = 'pending-debounce-caption';
  await page.locator('#rkr-figure-caption').fill(caption);
  await page.locator('#rkr-figure-dialog .rkr-cell-dialog-close').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(`saved /${slug}`, {
    timeout: 10_000
  });
  await publishSlug(page, slug);
  const res = await page.request.get(`/${slug}`);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain(caption);
});

// Client-side ingest resize: a 4000×3000 PNG should be resized to
// long-edge 3200 and re-encoded as WebP by the browser BEFORE
// uploadImage hashes it. The bytes the server stores are then byte-
// identical to what the client has in OPFS — no coord divergence
// between editor canvas and server-applied ops.
test('editor: client-side ingest resize clamps to 3200 long-edge and re-encodes as WebP', async ({
  page
}) => {
  await login(page);
  await page.goto('/admin/editor');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await page.locator('#rkr-title').fill('e2e resize');
  await setSlug(page, `e2e-resize-${Date.now()}`);

  // 4000×3000 PNG. The full encoded buffer is a few hundred KB so
  // this stays test-fast while sitting comfortably above the 3200
  // clamp on both axes.
  const big = await sharp({
    create: { width: 4000, height: 3000, channels: 3, background: { r: 20, g: 80, b: 160 } }
  })
    .png()
    .toBuffer();
  await page.locator('#rkr-image-input').setInputFiles({
    name: 'big.png',
    mimeType: 'image/png',
    buffer: big
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded big/, {
    timeout: 15_000
  });

  // The OPFS-stored blob must be the resized WebP. Read it back via
  // page.evaluate, decode dimensions via createImageBitmap.
  const dims = await page.evaluate(async () => {
    const opfs = await navigator.storage.getDirectory();
    const dir = await opfs.getDirectoryHandle('originals');
    for await (const [name, handle] of (
      dir as FileSystemDirectoryHandle & {
        entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
      }
    ).entries()) {
      if (!name.endsWith('.webp') || handle.kind !== 'file') continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      const bmp = await createImageBitmap(file);
      const out = { width: bmp.width, height: bmp.height, ext: 'webp' };
      bmp.close();
      return out;
    }
    return null;
  });
  expect(dims).not.toBeNull();
  // Long edge clamped to 3200; aspect ratio preserved (4000:3000 = 4:3
  // → 3200×2400). Rounding tolerance ±1 px on the short edge.
  expect(dims).toEqual({ width: 3200, height: 2400, ext: 'webp' });
});

// Orphan outbox-blob GC: outbox.append writes the blob before the
// JSON (intentional — blob-without-JSON is GC'd; JSON-without-blob
// halts the drain). If the JSON write fails (quota, IO), the blob
// orphans under outbox-blobs/. runEviction doesn't reach this dir.
// gcOrphanOutboxBlobs runs at startup to sweep them. This test
// plants an orphan and verifies the next page load reclaims it.
test('outbox: gcOrphanOutboxBlobs sweeps blobs without matching JSON entries', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );

  // Plant an orphan: write outbox-blobs/9999.bin with no matching
  // outbox/9999.<op>.json. Seq 9999 is high enough to dodge any
  // entry that prior tests in this run might have produced.
  await page.evaluate(async () => {
    const opfs = await navigator.storage.getDirectory();
    const dir = await opfs.getDirectoryHandle('outbox-blobs', { create: true });
    const fh = await dir.getFileHandle('9999.bin', { create: true });
    const w = await fh.createWritable();
    await w.write(new Uint8Array([1, 2, 3, 4]));
    await w.close();
  });

  // Reload — startup runs gcOrphanOutboxBlobs.
  await page.reload();
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );

  // The orphan should be gone; any legitimate <seq>.bin paired
  // with an outbox/<seq>.<op>.json must survive (we didn't plant
  // any, so the assertion is "9999.bin is absent" specifically).
  const orphanGone = await page.evaluate(async () => {
    const opfs = await navigator.storage.getDirectory();
    const dir = await opfs.getDirectoryHandle('outbox-blobs').catch(() => null);
    if (!dir) return true;
    try {
      await dir.getFileHandle('9999.bin');
      return false;
    } catch {
      return true;
    }
  });
  expect(orphanGone).toBe(true);
});

// Admin chrome on the public site: post-login lands on /, the admin
// strip shows New post + Logout; on a /:slug page the strip also
// shows Edit this post → /admin/editor?slug=<slug>; the editor
// pre-populates the form + body from the existing post.
test('admin chrome: New post + Edit this post route into the editor', async ({ page }) => {
  await login(page);
  await expect(page).toHaveURL((url) => new URL(url).pathname === '/');

  // Seed an existing post so /:slug renders something to edit.
  const slug = `e2e-chrome-${Date.now()}`;
  const seed = await page.request.post('/admin/posts', {
    data: {
      slug,
      title: 'admin-chrome seed',
      status: 'published',
      markdown: 'chrome body\n'
    }
  });
  expect(seed.status()).toBe(200);

  // Index: New post link is in the admin strip, takes us to the editor.
  await page.goto('/');
  await page.getByRole('link', { name: 'New post' }).click();
  await expect(page).toHaveURL((url) => new URL(url).pathname === '/admin/editor');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  // Post page: Edit this post link is in the admin strip and routes
  // into the editor with ?slug=<slug>. After clicking we re-navigate
  // with &e2e=1 appended (the link itself doesn't carry it) so the
  // offline-ready hook becomes available for the rest of the test.
  await page.goto(`/${slug}`);
  await expect(page.getByRole('link', { name: 'Edit this post' })).toBeVisible();
  await page.getByRole('link', { name: 'Edit this post' }).click();
  await expect(page).toHaveURL((url) => {
    const u = new URL(url);
    return u.pathname === '/admin/editor' && u.searchParams.get('slug') === slug;
  });
  await page.goto(`/admin/editor?slug=${slug}&e2e=1`);
  await page.evaluate(
    () => (window as unknown as { __rkrOfflineReady: Promise<void> }).__rkrOfflineReady
  );
  // Editor pre-populated from the bundle pinPost wrote into OPFS.
  await expect(page.locator('#rkr-slug')).toHaveValue(slug);
  await expect(page.locator('#rkr-title')).toHaveValue('admin-chrome seed');
  await expect(page.locator('#rkroll-admin-article')).toContainText('chrome body');
});

// /admin/posts lists drafts + published, surfaces edit + delete.
test('admin posts: lists drafts + published, delete removes the row', async ({ page }) => {
  await login(page);

  // Seed one published + one draft so the listing has both.
  const stamp = Date.now();
  const pubSlug = `e2e-pub-${stamp}`;
  const draftSlug = `e2e-draft-${stamp}`;
  for (const [slug, status] of [
    [pubSlug, 'published'],
    [draftSlug, 'draft']
  ] as const) {
    const res = await page.request.post('/admin/posts', {
      data: { slug, title: `e2e ${status}`, status, markdown: 'body\n' }
    });
    expect(res.status()).toBe(200);
  }

  // The homepage doubles as the admin posts list when authed; no
  // separate /admin/posts tab any more.
  await page.goto('/');
  await expect(page.getByRole('cell', { name: 'e2e published', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'e2e draft', exact: true })).toBeVisible();

  // Delete the draft via the row's submit form. The form 303-
  // redirects back to /admin/posts; that route 301s to / so the
  // browser ends up on the homepage with the draft row gone.
  await page.locator(`form[action="/admin/posts/${draftSlug}/delete"] button`).click();
  await expect(page).toHaveURL((url) => new URL(url).pathname === '/');
  await expect(page.getByRole('cell', { name: 'e2e draft', exact: true })).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'e2e published', exact: true })).toBeVisible();
});

// /admin/posts per-row status select + pin/unpin button. The status
// form auto-submits on change; pin downloads the bundle into OPFS
// and flips the button to "unpin"; clicking again flips meta.mode
// back to 'cached'.
test('admin posts: per-row status flip + pin/unpin', async ({ page }) => {
  await login(page);

  // Seed an image first so the pin path exercises the originals
  // fetch loop (otherwise the manifest's originals[] is empty and
  // that branch isn't covered).
  // Generated by sharp({ create: { 1x1 RGBA } }).png() — the prior
  // hand-coded fixture was technically valid PNG but libspng (used by
  // sharp's full-decode path) refused it. ingestStream's re-encode
  // step decodes uploads now, so the fixture must round-trip cleanly.
  const PNG_1X1_TEAL =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgaGj4DwADhAIAV8n6LgAAAABJRU5ErkJggg==';
  const upload = await page.request.post('/admin/upload', {
    multipart: {
      file: { name: 'pin.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1X1_TEAL, 'base64') }
    }
  });
  expect(upload.status()).toBe(200);
  const { id: imageId } = (await upload.json()) as { id: string };

  const slug = `e2e-row-${Date.now()}`;
  const seed = await page.request.post('/admin/posts', {
    data: {
      slug,
      title: 'e2e row',
      status: 'draft',
      markdown: `body\n\n::image{#${imageId.slice(0, 8)} alt="x"}\n`
    }
  });
  expect(seed.status()).toBe(200);

  // The homepage doubles as the admin posts list when authed.
  await page.goto('/');

  const row = page.locator(`tr[data-slug="${slug}"]`);
  await expect(row).toBeVisible();

  // ---- 1. status flip: select 'published' → form auto-submits → 303
  //         redirect → 301 → / → row shows is-published.
  await row.locator('select[name="status"]').selectOption('published');
  await expect(page).toHaveURL((url) => new URL(url).pathname === '/');
  await expect(row.locator('select[name="status"]')).toHaveValue('published');
  await expect(row.locator('select[name="status"]')).toHaveClass(/is-published/);

  // The frontmatter on disk really flipped — the public /:slug page
  // is now reachable.
  const pub = await page.request.get(`/${slug}`, { maxRedirects: 0 });
  expect(pub.status()).toBe(200);

  // ---- 2. pin: button enables once OPFS init resolves. Click pins
  //         the post (downloads originals + sidecars + draft body) →
  //         button flips to "unpin" with aria-pressed=true.
  const pinBtn = row.locator('button[data-pin-toggle]');
  await expect(pinBtn).toBeEnabled({ timeout: 10_000 });
  await expect(pinBtn).toHaveText('pin');
  await pinBtn.click();
  await expect(pinBtn).toHaveText('unpin', { timeout: 15_000 });
  await expect(pinBtn).toHaveAttribute('aria-pressed', 'true');

  // ---- 3. unpin: flips meta.mode back to 'cached' (data stays in
  //         OPFS so a re-pin doesn't have to refetch).
  await pinBtn.click();
  await expect(pinBtn).toHaveText('pin', { timeout: 5_000 });
  await expect(pinBtn).toHaveAttribute('aria-pressed', 'false');
});

// Phantom-selection guard: Android Firefox creates DOM Ranges that
// span only non-text content (paragraph breaks, atomic figure, CSS
// gaps) during scroll-intended touches. range.toString() is empty,
// but the OS action bar still pops. main.ts has a selectionchange
// listener that clears such ranges; this test exercises that path.
//
// Playwright runs desktop Chromium, not Android Firefox, so the OS
// action bar isn't directly observable here — but the DOM mechanism
// (the empty-content Range) is W3C-standard and reproduces in any
// browser. If the guard fires and clears, we know the JS code is
// correct; the remaining variable is whether Android Firefox honors
// the selection clear by dismissing its native toolbar.
test('editor: selectionchange guard clears empty-content ranges', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  // Insert a figure so the doc has a non-text node to span.
  await page.locator('#rkr-image-input').setInputFiles({
    name: 'phantom.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1X1_BLUE, 'base64')
  });
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded phantom\.png/, {
    timeout: 10_000
  });

  // Synthesize the phantom-Range Firefox would create. Range start
  // at the article root, end just past the figure node. No text
  // content captured → range.toString() === ''.
  const observed = await page.evaluate(() => {
    const article = document.querySelector('#rkroll-admin-article');
    if (!article) throw new Error('article missing');
    const range = document.createRange();
    range.setStart(article, 0);
    range.setEnd(article, Math.max(1, article.childNodes.length));
    const sel = window.getSelection();
    if (!sel) throw new Error('no Selection api');
    sel.removeAllRanges();
    sel.addRange(range);
    return {
      rangeBeforeTick: sel.rangeCount,
      textBeforeTick: sel.toString()
    };
  });
  expect(observed.textBeforeTick).toBe('');
  expect(observed.rangeBeforeTick).toBe(1);
  // selectionchange dispatches as a microtask; wait one tick.
  await page.waitForTimeout(50);
  const rangeAfterTick = await page.evaluate(() => window.getSelection()?.rangeCount ?? 0);
  expect(rangeAfterTick).toBe(0);
});

// Counter-test: a real text selection (non-empty range.toString)
// must NOT be cleared by the guard.
test('editor: selectionchange guard leaves real text selections alone', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  // Type some prose into the editor so there's text to select.
  await page.locator('#rkroll-admin-article').click();
  await page.keyboard.type('hello world');

  const text = await page.evaluate(() => {
    const article = document.querySelector('#rkroll-admin-article');
    if (!article) throw new Error('article missing');
    // Find a text node containing "hello world".
    let textNode: Text | null = null;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (node.data.includes('hello')) {
        textNode = node;
        break;
      }
    }
    if (!textNode) throw new Error('text node missing');
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5); // "hello"
    const sel = window.getSelection();
    if (!sel) throw new Error('no Selection api');
    sel.removeAllRanges();
    sel.addRange(range);
    return sel.toString();
  });
  expect(text).toBe('hello');

  // Real selection survives — guard does NOT clear it.
  const surviving = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(surviving).toBe('hello');
});

// Anonymous visitor sees no admin chrome.
test('admin chrome: hidden for anonymous visitors', async ({ browser }) => {
  // Fresh context = no session cookie.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'New post' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Logout' })).toHaveCount(0);
  await ctx.close();
});
