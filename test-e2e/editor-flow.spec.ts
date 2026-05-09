// End-to-end coverage for the editor's image flow:
//   1. Insert image  → POST /admin/upload + figure node inserted
//   2. Set matrix    → ::figure attrs panel writes through to the doc
//   3. Save          → POST /admin/posts persists markdown for /:slug
//
// The unit tests cover each route in isolation; this spec exercises the
// browser glue (TipTap insertContent, panel re-population on selection,
// JSON-to-markdown serialization on save) that only runs in a real DOM.

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
  await page.locator('#rkr-slug').fill(`e2e-percell-${Date.now()}`);

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

  // The figure now has ids="A,B". The image-edit panel should be
  // hidden because no cell is selected yet.
  await expect(page.locator('#rkr-figure-attrs')).toBeVisible();
  await expect(page.locator('#rkr-figure-ids')).toHaveValue(`${idA},${idB}`);
  await expect(page.locator('#rkr-image-edit')).toBeHidden();

  // Click the second thumb (data-cell-index="1"). Panel reveals
  // scoped to that cell's id.
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

  // Switch to the first cell. Its panel should show the empty state
  // (no ops applied yet), distinct from the second cell.
  await page.locator('img[data-cell-index="0"]').click();
  await expect(page.locator('img[data-cell-index="0"]')).toHaveClass(/is-active-cell/);
  await expect(page.locator('img[data-cell-index="1"]')).not.toHaveClass(/is-active-cell/);
  await expect(page.locator('#rkr-image-edits li')).toHaveCount(0);
  await expect(page.locator('#rkr-image-save-btn')).toBeDisabled();
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
  await page.locator('#rkr-slug').fill(`e2e-offline-${Date.now()}`);

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

  await expect(page.locator('#rkr-figure-attrs')).toBeVisible();
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
  await page.locator('#rkr-slug').fill(`e2e-offlineedit-${Date.now()}`);

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

  // ---- 1. go offline + rotate + save -------------------------------
  await context.setOffline(true);
  // Tell the SPA we're offline so getState() flips before Save fires.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));

  await expect(page.locator('#rkr-image-edit')).toBeVisible();
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
  await page.locator('#rkr-slug').fill(slug);
  await page.locator('#rkr-status').selectOption('published');

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

  // Once drainSavePost succeeds, /:slug returns the rendered post.
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

  // Wait past the 500ms debounce + a small safety margin so the OPFS
  // write completes before reload.
  await page.waitForTimeout(900);

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

  await expect(page.locator('#rkr-image-edit')).toBeVisible();
  await expect(page.locator('#rkr-image-save-btn')).toBeDisabled();

  await page.locator('#rkr-image-rotate-r-btn').click();
  await expect(page.locator('#rkr-image-edits li')).toHaveCount(1);
  await expect(page.locator('#rkr-image-save-btn')).toBeEnabled();
  // Wait past the 500ms draft-persist debounce so the figure insert
  // + the persistImageState write both land in OPFS before reload.
  await page.waitForTimeout(900);

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

  await expect(page.locator('#rkr-image-edit')).toBeVisible();
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
  await page.locator('#rkr-slug').fill(slug);
  await page.locator('#rkr-status').selectOption('published');
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

  // The public site renders v2.
  const html = await (await page.request.get(`/${slug}`)).text();
  expect(html).toContain('v2 body');
});
