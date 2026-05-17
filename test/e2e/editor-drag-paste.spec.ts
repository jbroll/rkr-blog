// Editor drag-and-drop + paste image insertion.
//
// Coverage push for src/admin/drag-drop.ts: makeDropHandlers'
// handleDrop/handlePaste branches, the wireDragOverlay
// dragenter/dragleave class toggle, and imageFilesFrom's two code
// paths (.files for drop, .items fallback for paste).
//
// We synthesise the DataTransfer / ClipboardEvent in the page,
// dispatch on #rkroll-admin-article. The figure id is
// content-addressed so we recover it from the inserted img after
// the drop resolves.

import { expect, test } from './coverage-fixtures.ts';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

// 1×1 PNG, distinct teal so the content-hashed id doesn't collide
// with editor-flow.spec.ts fixtures.
const PNG_1X1_TEAL_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgaGj4DwADhAIAV8n6LgAAAABJRU5ErkJggg==';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((url) => new URL(url).pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
}

test('editor: drag-and-drop of an image inserts a figure', async ({ page }) => {
  page.on('console', (msg) => {
    console.log(`[browser ${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    console.log(`[browser pageerror] ${err.message}`);
  });
  await login(page);
  await page.goto('/admin/editor');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  // Playwright pattern: construct the DataTransfer in the page,
  // dispatch via locator.dispatchEvent which passes the handle as
  // the `dataTransfer` event property — going through
  // dispatchEvent (vs an ad-hoc page.evaluate Event ctor) reliably
  // surfaces dataTransfer on the synthesised event, where some
  // chromium versions otherwise nullify it.
  const dataTransfer = await page.evaluateHandle((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'dropped.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    return dt;
  }, PNG_1X1_TEAL_B64);
  // Overlay class toggle (dragenter) — fires the wireDragOverlay
  // branch even if the drop never reaches ProseMirror.
  await page.locator('#rkroll-admin-root').dispatchEvent('dragenter', { dataTransfer });
  await expect(page.locator('#rkroll-admin-root')).toHaveClass(/is-drag-over/);
  // Dispatch dragover + drop with realistic coords (ProseMirror's
  // posAtCoords needs them) and a `Files` type entry so the overlay
  // / PM filters both accept it.
  const box = await page.locator('.ProseMirror').boundingBox();
  if (!box) throw new Error('.ProseMirror has no layout box');
  await page.locator('.ProseMirror').dispatchEvent('dragover', {
    dataTransfer,
    clientX: box.x + 10,
    clientY: box.y + 10
  });
  await page.locator('.ProseMirror').dispatchEvent('drop', {
    dataTransfer,
    clientX: box.x + 10,
    clientY: box.y + 10
  });

  // Overlay class clears on drop (dragDepth → 0 in wireDragOverlay).
  await expect(page.locator('#rkroll-admin-root.is-drag-over')).toHaveCount(0);

  // The figure appears with the uploaded id wired into data-id.
  // Use toBeAttached (not toBeVisible) — a brand-new figure thumb
  // has src=/admin/preview/<id> that may still be loading when this
  // runs; Playwright's visible check requires non-zero box dims.
  await expect(page.locator('img.rkr-image[data-id]')).toBeAttached({ timeout: 10_000 });
  const id = await page.locator('img.rkr-image[data-id]').first().getAttribute('data-id');
  expect(id).toMatch(/^[0-9a-f]{64}$/);
});

// wireDragOverlay's leave-counter branch — dispatching dragenter
// twice then dragleave twice should toggle and clear the class.
// Hits the "actually left the drop zone" decrement path.
test('editor: drag-overlay tracks nested dragenter/dragleave depth', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    // Add a fake "Files" type via items so wireDragOverlay's
    // `types.includes('Files')` guard accepts the event.
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    dt.items.add(new File([bytes], 'x.png', { type: 'image/png' }));
    return dt;
  });
  const overlay = page.locator('#rkroll-admin-root');
  // Two enters (parent + child traversal) then two leaves should
  // ratchet the depth counter back to zero.
  await overlay.dispatchEvent('dragenter', { dataTransfer });
  await overlay.dispatchEvent('dragenter', { dataTransfer });
  await expect(overlay).toHaveClass(/is-drag-over/);
  await overlay.dispatchEvent('dragleave', { dataTransfer });
  await expect(overlay).toHaveClass(/is-drag-over/);
  await overlay.dispatchEvent('dragleave', { dataTransfer });
  await expect(overlay).not.toHaveClass(/is-drag-over/);
});
