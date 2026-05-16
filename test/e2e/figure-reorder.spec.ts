// E2E: figure image reorder. Drag persists across save; a stationary
// tap still opens per-cell edit; keyboard arrows reorder and keep focus
// on the moved image. Harness mirrors editor-flow.spec.ts.

import { expect, test } from './coverage-fixtures.ts';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

// 1×1 PNGs distinct from each other and from those used in
// editor-flow.spec.ts (content-hash uniqueness prevents id collisions).
const PNG_BLACK =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_RED =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const PNG_BLUE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((u) => new URL(u).pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
}

/** Upload a base64 PNG via the source-picker dialog → local branch →
 *  #rkr-image-input. `triggerLocator` is clicked to open the picker
 *  (toolbar +Image button for the first image; figure's + button for
 *  subsequent appends). Returns the status text to await. */
async function openPickerAndUpload(
  page: import('@playwright/test').Page,
  triggerLocator: import('@playwright/test').Locator,
  b64: string,
  filename: string
): Promise<void> {
  const picker = page.locator('#rkr-source-picker');
  await triggerLocator.click();
  await expect(picker).toBeVisible();
  await picker.locator('button[data-source="local"]').click();
  await expect(picker).toBeHidden();
  await page.locator('#rkr-image-input').setInputFiles({
    name: filename,
    mimeType: 'image/png',
    buffer: Buffer.from(b64, 'base64')
  });
}

/** Read data-id values in DOM order from img[data-cell-index] elements. */
function ids(page: import('@playwright/test').Page): Promise<(string | null)[]> {
  return page.$$eval('img[data-cell-index]', (els) =>
    els.map((e) => (e as HTMLImageElement).getAttribute('data-id'))
  );
}

test('drag reorder moves a thumb and survives save; tap still edits', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  await page.locator('#rkr-title').fill(`e2e reorder-drag-${Date.now()}`);

  // ---- Build a 3-image figure via source picker (real UI flow) --------

  // Image 1: toolbar +Image → picker local → upload
  await openPickerAndUpload(
    page,
    page.getByRole('button', { name: '+Image', exact: true }),
    PNG_BLACK,
    'reorder-a.png'
  );
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded reorder-a\.png/, {
    timeout: 10_000
  });
  await expect(page.locator('img[data-cell-index="0"]')).toBeVisible();

  // Image 2: figure's + button → picker local → upload
  await openPickerAndUpload(page, page.locator('button[data-add-image]'), PNG_RED, 'reorder-b.png');
  await expect(page.locator('#rkroll-admin-status')).toContainText(
    /^appended 1 image\(s\) to figure/,
    { timeout: 10_000 }
  );
  await expect(page.locator('img[data-cell-index="1"]')).toBeVisible();

  // Image 3: figure's + button again → picker local → upload
  await openPickerAndUpload(
    page,
    page.locator('button[data-add-image]'),
    PNG_BLUE,
    'reorder-c.png'
  );
  await expect(page.locator('#rkroll-admin-status')).toContainText(
    /^appended 1 image\(s\) to figure/,
    { timeout: 10_000 }
  );
  await expect(page.locator('img[data-cell-index="2"]')).toBeVisible();

  const before = await ids(page);
  expect(before).toHaveLength(3);

  // ---- Drag thumb 0 past thumb 2 via synthetic Pointer Events ----------
  // page.mouse.move({steps}) does not reliably deliver intermediate
  // pointermove events to the page in Playwright's CDP implementation —
  // only the final position is dispatched. Synthetic PointerEvents from
  // evaluate() are fully delivered and tested the correct code path.
  const a = await page.locator('img[data-cell-index="0"]').boundingBox();
  const c = await page.locator('img[data-cell-index="2"]').boundingBox();
  if (!a || !c) throw new Error('thumbs missing');

  // Move from the centre of thumb 0 to just past the right edge of thumb 2
  // so dropIndexFor returns 3 → to = 3-1 = 2 (cell 0 goes to the end).
  await page.evaluate(
    ({ startX, startY, endX, endY }) => {
      const img = document.querySelector('img[data-cell-index="0"]') as HTMLElement | null;
      if (!img) throw new Error('img[data-cell-index="0"] not found');
      const pid = 1;
      const base = { bubbles: true, cancelable: true, pointerId: pid, pointerType: 'mouse' };
      img.dispatchEvent(
        new PointerEvent('pointerdown', { ...base, buttons: 1, clientX: startX, clientY: startY })
      );
      const steps = 20;
      for (let i = 1; i <= steps; i++) {
        const x = startX + ((endX - startX) * i) / steps;
        const y = startY + ((endY - startY) * i) / steps;
        img.dispatchEvent(
          new PointerEvent('pointermove', { ...base, buttons: 1, clientX: x, clientY: y })
        );
      }
      img.dispatchEvent(
        new PointerEvent('pointerup', { ...base, buttons: 0, clientX: endX, clientY: endY })
      );
    },
    {
      startX: a.x + a.width / 2,
      startY: a.y + a.height / 2,
      endX: c.x + c.width + 12,
      endY: c.y + c.height / 2
    }
  );

  // After the drag the ids must have changed.
  await expect.poll(() => ids(page)).not.toEqual(before);
  const after = await ids(page);
  // Cell 0 moved to the end → [1, 2, 0] permutation.
  expect(after).toEqual([before[1], before[2], before[0]]);

  // ---- Save then re-open via ?slug= — reordered ids must persist -----
  const slug = `e2e-reorder-drag-${Date.now()}`;
  await page.locator('#rkr-slug').evaluate((el, v) => {
    (el as HTMLInputElement).value = v as string;
  }, slug);
  await page.locator('#rkr-title').fill('e2e reorder drag persistence');

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^saved \//, {
    timeout: 10_000
  });

  // Navigate to the edit URL for the saved post: ?slug= pins the server
  // copy into OPFS and restores the editor from the saved markdown — no
  // reliance on the draft debounce timing.
  await page.goto(`/admin/editor?e2e=1&slug=${encodeURIComponent(slug)}`);
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
  await expect(page.locator('img[data-cell-index="2"]')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => ids(page)).toEqual(after);

  // ---- A stationary tap still opens per-cell edit (no reorder) --------
  const orderPreTap = await ids(page);
  await page.locator('img[data-cell-index="0"]').click();
  // The per-cell image-edit panel is the canonical indicator that the
  // tap-to-edit path ran.
  await expect(page.locator('#rkr-image-edit')).toBeVisible();
  expect(await ids(page)).toEqual(orderPreTap);
});

test('keyboard ArrowRight reorders a focused thumb and keeps focus', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor?e2e=1');
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();

  await page.locator('#rkr-title').fill(`e2e reorder-kb-${Date.now()}`);

  // Build a 2-image figure.
  await openPickerAndUpload(
    page,
    page.getByRole('button', { name: '+Image', exact: true }),
    PNG_BLACK,
    'kb-a.png'
  );
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^uploaded kb-a\.png/, {
    timeout: 10_000
  });
  await expect(page.locator('img[data-cell-index="0"]')).toBeVisible();

  await openPickerAndUpload(page, page.locator('button[data-add-image]'), PNG_RED, 'kb-b.png');
  await expect(page.locator('#rkroll-admin-status')).toContainText(
    /^appended 1 image\(s\) to figure/,
    { timeout: 10_000 }
  );
  await expect(page.locator('img[data-cell-index="1"]')).toBeVisible();

  const before = await ids(page);
  expect(before).toHaveLength(2);

  // Focus thumb 0 and press ArrowRight → it should move to index 1.
  await page.locator('img[data-cell-index="0"]').focus();
  await page.keyboard.press('ArrowRight');

  // Order must flip.
  await expect.poll(() => ids(page)).toEqual([before[1], before[0]]);

  // Code-review concern (Task 4): after the ProseMirror re-render,
  // focus must stay on the moved image (now at index 1) so a keyboard
  // user can keep pressing arrows. The moved image was before[0].
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (document.activeElement as HTMLElement | null)?.getAttribute('data-id')
        ),
      { timeout: 3_000 }
    )
    .toBe(before[0]);

  // Code-review concern (Task 7): the aria-live status node must carry
  // the move announcement AFTER the re-render — commitReorder writes it
  // to the re-resolved (live) node, not the detached pre-commit one.
  // Moved from index 0 → index 1 of 2 → "Moved to position 2 of 2".
  await expect
    .poll(
      () => page.evaluate(() => document.querySelector('[data-reorder-status]')?.textContent ?? ''),
      { timeout: 3_000 }
    )
    .toBe('Moved to position 2 of 2');
});
