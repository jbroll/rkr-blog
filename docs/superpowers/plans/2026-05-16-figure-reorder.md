# Figure Image Reorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorder images within a multi-image figure by tablet-first pointer-drag (and keyboard arrows for a11y), without changing the existing tap-to-edit behavior.

**Architecture:** Pure permute/hit-test helpers live in a new `src/admin/figure-reorder.ts` and are unit-tested under `node --test`. The same file's `wireFigureReorder(editor)` installs *delegated* pointer/keydown/click-capture listeners on `editor.view.dom` (mirroring the existing delegated click handler in `main.ts`), drives the drag, and commits one `setNodeMarkup` transaction located by `nodeDOM` match. Browser glue is verified by a Playwright spec. `main.ts`'s only change is one call.

**Tech Stack:** TypeScript (ESM, `--experimental-strip-types`), TipTap/ProseMirror, Pointer Events API, `node:test`, Playwright. Spec: `docs/superpowers/specs/2026-05-16-figure-reorder-design.md`.

---

## File Structure

- **Create `src/admin/figure-reorder.ts`** — pure helpers (`moveItem`, `reorderFigureCells`, `dropIndexFor`) + `wireFigureReorder(editor)` DOM wiring (drag state machine, insertion indicator, edge auto-scroll, keyboard arrows, capture-phase post-drag click suppression, commit).
- **Create `test/admin/figure-reorder.test.ts`** — unit coverage for the three pure helpers.
- **Modify `src/admin/figure-node.ts`** — thumbs get `tabindex`/`role`/`aria-label`; add an `aria-live` status node.
- **Create `test/admin/figure-node-a11y.test.ts`** — assert `renderHTML` emits the a11y attributes + status node.
- **Modify `src/admin/main.ts`** — one call: `wireFigureReorder(editor)`.
- **Modify `src/templates/admin-styles.ts`** — `touch-action:none` override for thumbs, focus ring, `.is-dragging`, `.rkr-multi-drop-indicator`.
- **Create `test/e2e/figure-reorder.spec.ts`** — Playwright: drag reorder persists across save; tap still edits; keyboard arrow reorders.

Conventions: unit tests use `node:assert/strict` + `node:test` (see `test/admin/matrix-control.test.ts`). `src/admin/**` is excluded from the c8 gate, so these unit tests assert correctness but don't affect coverage; browser glue is covered by the e2e ratchet. Gate command after each task: `npm run check`. Single unit file: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/admin/figure-reorder.test.ts`.

---

### Task 1: Pure permute helpers (`moveItem`, `reorderFigureCells`)

**Files:**
- Create: `src/admin/figure-reorder.ts`
- Test: `test/admin/figure-reorder.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/admin/figure-reorder.test.ts`:

```ts
// Pure permute helpers for figure image reorder. DOM wiring
// (wireFigureReorder) is exercised by test/e2e/figure-reorder.spec.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { moveItem, reorderFigureCells } from '../../src/admin/figure-reorder.ts';

test('moveItem: moves an element and returns a new array', () => {
  const a = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveItem(a, 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(a, 3, 1), ['a', 'd', 'b', 'c']);
  assert.deepEqual(a, ['a', 'b', 'c', 'd']); // input untouched
});

test('moveItem: no-op cases return an equal array', () => {
  assert.deepEqual(moveItem(['a', 'b'], 1, 1), ['a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], -1, 0), ['a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 0, 5), ['a', 'b']);
  assert.deepEqual(moveItem(['a'], 0, 0), ['a']);
});

test('reorderFigureCells: permutes ids/alts/captions in lockstep', () => {
  const out = reorderFigureCells(
    { ids: 'i1,i2,i3', alts: 'a1,a2,a3', captions: 'c1|c2|c3' },
    0,
    2
  );
  assert.deepEqual(out, { ids: 'i2,i3,i1', alts: 'a2,a3,a1', captions: 'c2|c3|c1' });
});

test('reorderFigureCells: pads short alts/captions to ids length before moving', () => {
  const out = reorderFigureCells({ ids: 'i1,i2,i3', alts: 'a1', captions: 'c1' }, 2, 0);
  assert.deepEqual(out, { ids: 'i3,i1,i2', alts: ',a1,', captions: '|c1|' });
});

test('reorderFigureCells: no-op returns the original strings', () => {
  const input = { ids: 'i1,i2', alts: 'a1,a2', captions: 'c1|c2' };
  assert.deepEqual(reorderFigureCells(input, 1, 1), input);
  assert.deepEqual(reorderFigureCells(input, 0, 9), input);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/admin/figure-reorder.test.ts`
Expected: FAIL — `Cannot find module '.../src/admin/figure-reorder.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/admin/figure-reorder.ts`:

```ts
// Figure image reorder: pure permute/hit-test helpers + delegated
// pointer/keyboard wiring. Spec:
// docs/superpowers/specs/2026-05-16-figure-reorder-design.md
// Reorder is one permutation applied in lockstep to the figure's
// three parallel arrays (ids ',', alts ',', captions '|').

/** Move arr[from] to index `to`, returning a NEW array. Clamps /
 *  no-ops when from===to or either index is out of [0, len). */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const n = arr.length;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return arr.slice();
  const copy = arr.slice();
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item as T);
  return copy;
}

export interface FigureCellArrays {
  ids: string;
  alts: string;
  captions: string;
}

/** Split the three parallel arrays, move cell from→to in lockstep,
 *  re-pad alts/captions to ids length, rejoin. Returns the original
 *  object when the move is a no-op (so callers can skip the commit). */
export function reorderFigureCells(
  attrs: FigureCellArrays,
  from: number,
  to: number
): FigureCellArrays {
  const ids = attrs.ids.split(',').map((s) => s.trim());
  const n = ids.length;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return attrs;
  const alts = attrs.alts.split(',').map((s) => s.trim());
  const captions = attrs.captions.split('|');
  while (alts.length < n) alts.push('');
  while (captions.length < n) captions.push('');
  alts.length = n;
  captions.length = n;
  return {
    ids: moveItem(ids, from, to).join(','),
    alts: moveItem(alts, from, to).join(','),
    captions: moveItem(captions, from, to).join('|')
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/admin/figure-reorder.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/admin/figure-reorder.ts test/admin/figure-reorder.test.ts
git commit -m "feat(figure-reorder): pure moveItem + reorderFigureCells helpers"
```

---

### Task 2: Pure drop-index hit-test (`dropIndexFor`)

**Files:**
- Modify: `src/admin/figure-reorder.ts`
- Test: `test/admin/figure-reorder.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/admin/figure-reorder.test.ts`:

```ts
import { dropIndexFor } from '../../src/admin/figure-reorder.ts';

test('dropIndexFor: insertion index = count of midpoints before the pointer', () => {
  // Three cells centered at x=50,150,250.
  const mids = [50, 150, 250];
  assert.equal(dropIndexFor(mids, 10), 0); // before all
  assert.equal(dropIndexFor(mids, 100), 1); // between 1st and 2nd
  assert.equal(dropIndexFor(mids, 200), 2); // between 2nd and 3rd
  assert.equal(dropIndexFor(mids, 999), 3); // after all
});

test('dropIndexFor: empty list → 0', () => {
  assert.equal(dropIndexFor([], 123), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/admin/figure-reorder.test.ts`
Expected: FAIL — `dropIndexFor` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/admin/figure-reorder.ts` (after `reorderFigureCells`):

```ts
/** Insertion index for a pointer at coordinate `pos` (px along the
 *  drag axis) given cell midpoints in DOM order. Equals the number of
 *  midpoints strictly less than `pos`; result is in [0, mids.length]. */
export function dropIndexFor(mids: number[], pos: number): number {
  let i = 0;
  while (i < mids.length && (mids[i] as number) < pos) i++;
  return i;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/admin/figure-reorder.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/admin/figure-reorder.ts test/admin/figure-reorder.test.ts
git commit -m "feat(figure-reorder): pure dropIndexFor hit-test helper"
```

---

### Task 3: Thumb a11y attributes + aria-live status node

**Files:**
- Modify: `src/admin/figure-node.ts:75-105`
- Test: `test/admin/figure-node-a11y.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/admin/figure-node-a11y.test.ts`:

```ts
// FigureNode.renderHTML must emit reorder a11y hooks: each thumb is a
// focusable button with a positional aria-label, plus a polite
// aria-live status node. Pure (no DOM) — calls renderHTML directly.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FigureNode } from '../../src/admin/figure-node.ts';

function render(ids: string): string {
  const fn = FigureNode.config.renderHTML as (p: { HTMLAttributes: unknown }) => unknown;
  const out = fn({
    HTMLAttributes: { ids, alts: '', captions: '', caption: '', matrix: '' }
  });
  return JSON.stringify(out);
}

test('thumbs are focusable buttons with positional aria-labels', () => {
  const s = render('a,b,c');
  assert.match(s, /"tabindex":"0"/);
  assert.match(s, /"role":"button"/);
  assert.match(s, /Image 1 of 3/);
  assert.match(s, /Image 3 of 3/);
});

test('a reorder aria-live status node is present', () => {
  const s = render('a,b');
  assert.match(s, /"aria-live":"polite"/);
  assert.match(s, /data-reorder-status/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/admin/figure-node-a11y.test.ts`
Expected: FAIL — no `tabindex` / `aria-live` in output.

- [ ] **Step 3: Write minimal implementation**

In `src/admin/figure-node.ts`, change the `thumbs` map (currently lines ~75-84) to:

```ts
    const thumbs: unknown[] = idList.map((id, i) => [
      'img',
      {
        src: `/admin/preview/${id}`,
        alt: '',
        class: 'rkr-image rkr-multi-thumb',
        'data-id': id,
        'data-cell-index': String(i),
        tabindex: '0',
        role: 'button',
        'aria-label': `Image ${i + 1} of ${idList.length}; press arrow keys to reorder`
      }
    ]);
```

Then add a status node: in the returned array, immediately AFTER the
`['div', { class: 'rkr-multi-thumbs', contenteditable: 'false' }, ...thumbs]`
entry (currently line ~105) and BEFORE the `['div', { class: 'rkr-multi-actions' ... }]`
entry, insert:

```ts
      [
        'div',
        {
          class: 'rkr-multi-status',
          'data-reorder-status': 'true',
          'aria-live': 'polite',
          contenteditable: 'false'
        },
        ''
      ],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/admin/figure-node-a11y.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/admin/figure-node.ts test/admin/figure-node-a11y.test.ts
git commit -m "feat(figure-reorder): focusable thumbs + aria-live status node"
```

---

### Task 4: `wireFigureReorder` — pointer drag, keyboard, click suppression, commit

**Files:**
- Modify: `src/admin/figure-reorder.ts`

No isolated unit test — this is browser glue (Pointer Events + ProseMirror). The pure logic it depends on is already covered (Tasks 1–2); end-to-end behavior is verified by Task 7. This task adds the function and must pass `npm run check` (typecheck for `tsconfig.browser.json` covers `src/admin/**`).

- [ ] **Step 1: Implement `wireFigureReorder`**

Append to `src/admin/figure-reorder.ts`:

```ts
import type { Editor } from '@tiptap/core';

const DRAG_THRESHOLD_PX = 8;
const EDGE_AUTOSCROLL_PX = 48;
const EDGE_SCROLL_STEP = 12;

/** Find the figure node position whose rendered DOM is `placeholder`.
 *  Same robust nodeDOM match the figure-delete path uses (posAtDOM is
 *  ambiguous on atoms). */
function figurePosFor(editor: Editor, placeholder: Element): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'figure' && editor.view.nodeDOM(pos) === placeholder) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

function commitReorder(editor: Editor, placeholder: Element, from: number, to: number): void {
  const pos = figurePosFor(editor, placeholder);
  if (pos === null) return;
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const next = reorderFigureCells(
    {
      ids: (node.attrs.ids as string | undefined) ?? '',
      alts: (node.attrs.alts as string | undefined) ?? '',
      captions: (node.attrs.captions as string | undefined) ?? ''
    },
    from,
    to
  );
  if (next.ids === ((node.attrs.ids as string | undefined) ?? '')) return; // no-op
  editor.commands.command(({ tr, dispatch }) => {
    if (dispatch) dispatch(tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...next }));
    return true;
  });
}

function thumbsOf(placeholder: Element): HTMLImageElement[] {
  return Array.from(
    placeholder.querySelectorAll<HTMLImageElement>('img[data-cell-index]')
  );
}

function announce(placeholder: Element, msg: string): void {
  const status = placeholder.querySelector('[data-reorder-status]');
  if (status) status.textContent = msg;
}

/** Install delegated reorder listeners on the editor DOM. Mirrors the
 *  existing delegated click handler in main.ts (the figure is a plain
 *  Node with no per-instance NodeView, so delegation is the only
 *  consistent attach point). Self-contained: a capture-phase click
 *  listener swallows the synthetic post-drag click so tap-to-edit in
 *  main.ts is untouched. */
export function wireFigureReorder(editor: Editor): void {
  const root = editor.view.dom as HTMLElement;
  let justDragged = false;

  root.addEventListener(
    'click',
    (ev) => {
      if (justDragged) {
        justDragged = false;
        ev.stopImmediatePropagation();
        ev.preventDefault();
      }
    },
    true // capture: runs before main.ts's bubble-phase click handler
  );

  root.addEventListener('pointerdown', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target || !target.matches('img[data-cell-index]')) return;
    const placeholder = target.closest('.rkr-figure-placeholder');
    if (!placeholder) return;
    const thumbs = thumbsOf(placeholder);
    const from = thumbs.indexOf(target as HTMLImageElement);
    if (from < 0 || thumbs.length < 2) return;

    const startX = ev.clientX;
    const startY = ev.clientY;
    let dragging = false;
    let indicator: HTMLDivElement | null = null;
    let dropIndex = from;
    let rafId = 0;

    const horizontal = (() => {
      if (thumbs.length < 2) return true;
      const a = thumbs[0]!.getBoundingClientRect();
      const b = thumbs[1]!.getBoundingClientRect();
      return Math.abs(b.left - a.left) >= Math.abs(b.top - a.top);
    })();

    const scrollContainer =
      (root.closest('#rkroll-admin-article') as HTMLElement | null) ?? root;

    const ensureIndicator = (): HTMLDivElement => {
      if (indicator) return indicator;
      const el = document.createElement('div');
      el.className = 'rkr-multi-drop-indicator';
      el.setAttribute('contenteditable', 'false');
      placeholder.querySelector('.rkr-multi-thumbs')?.appendChild(el);
      indicator = el;
      return el;
    };

    const positionIndicator = () => {
      const el = ensureIndicator();
      const ref = thumbs[Math.min(dropIndex, thumbs.length - 1)]!;
      const r = ref.getBoundingClientRect();
      const pr = (el.offsetParent as HTMLElement).getBoundingClientRect();
      if (horizontal) {
        const x = (dropIndex >= thumbs.length ? r.right : r.left) - pr.left;
        el.style.cssText = `left:${x}px;top:${r.top - pr.top}px;height:${r.height}px;width:2px;`;
      } else {
        const y = (dropIndex >= thumbs.length ? r.bottom : r.top) - pr.top;
        el.style.cssText = `top:${y}px;left:${r.left - pr.left}px;width:${r.width}px;height:2px;`;
      }
    };

    const autoscroll = () => {
      const sc = scrollContainer.getBoundingClientRect();
      if (lastY < sc.top + EDGE_AUTOSCROLL_PX) scrollContainer.scrollTop -= EDGE_SCROLL_STEP;
      else if (lastY > sc.bottom - EDGE_AUTOSCROLL_PX)
        scrollContainer.scrollTop += EDGE_SCROLL_STEP;
      rafId = requestAnimationFrame(autoscroll);
    };

    let lastY = startY;

    const onMove = (e: PointerEvent) => {
      lastY = e.clientY;
      if (!dragging) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD_PX) return;
        dragging = true;
        target.setPointerCapture(e.pointerId);
        target.classList.add('is-dragging');
        rafId = requestAnimationFrame(autoscroll);
      }
      const mids = thumbs.map((t) => {
        const r = t.getBoundingClientRect();
        return horizontal ? r.left + r.width / 2 : r.top + r.height / 2;
      });
      dropIndex = dropIndexFor(mids, horizontal ? e.clientX : e.clientY);
      positionIndicator();
    };

    const cleanup = () => {
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', onUp);
      root.removeEventListener('pointercancel', onCancel);
      if (rafId) cancelAnimationFrame(rafId);
      target.classList.remove('is-dragging');
      indicator?.remove();
    };

    const onUp = () => {
      const wasDragging = dragging;
      let to = dropIndex > from ? dropIndex - 1 : dropIndex;
      to = Math.max(0, Math.min(thumbs.length - 1, to));
      cleanup();
      if (wasDragging) {
        justDragged = true; // swallow the trailing click
        if (to !== from) {
          commitReorder(editor, placeholder, from, to);
          announce(placeholder, `Moved to position ${to + 1} of ${thumbs.length}`);
        }
      }
    };

    const onCancel = () => cleanup();

    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onCancel);
  });

  root.addEventListener('keydown', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target || !target.matches('img[data-cell-index]')) return;
    const dir =
      ev.key === 'ArrowLeft' || ev.key === 'ArrowUp'
        ? -1
        : ev.key === 'ArrowRight' || ev.key === 'ArrowDown'
          ? 1
          : 0;
    if (dir === 0) return;
    const placeholder = target.closest('.rkr-figure-placeholder');
    if (!placeholder) return;
    const thumbs = thumbsOf(placeholder);
    const from = thumbs.indexOf(target as HTMLImageElement);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= thumbs.length) return;
    ev.preventDefault();
    commitReorder(editor, placeholder, from, to);
    const moved = thumbsOf(placeholder)[to];
    moved?.focus();
    announce(placeholder, `Moved to position ${to + 1} of ${thumbs.length}`);
  });
}
```

Move the `import type { Editor } from '@tiptap/core';` line to the top of the file with the other imports (TypeScript requires imports before other statements when the file is type-checked; keep all imports grouped at the top).

- [ ] **Step 2: Verify the gate passes**

Run: `npm run check`
Expected: typecheck (incl. `tsconfig.browser.json` over `src/admin/**`) + biome + tests all green. If biome flags the `from './figure-reorder.ts'` import extension elsewhere, match the extension convention of the neighboring imports in that file.

- [ ] **Step 3: Commit**

```bash
git add src/admin/figure-reorder.ts
git commit -m "feat(figure-reorder): pointer-drag + keyboard wiring, commit, click suppression"
```

---

### Task 5: Wire it into the editor (`main.ts`)

**Files:**
- Modify: `src/admin/main.ts` (import block near line 15; call site near the delegated click handler at line ~244-309)

- [ ] **Step 1: Add the import**

In `src/admin/main.ts`, add to the import group (match the extension style of the import immediately above it — `./image-edit-panel` at line 15 omits the extension):

```ts
import { wireFigureReorder } from './figure-reorder';
```

- [ ] **Step 2: Add the call**

In `src/admin/main.ts`, immediately AFTER the closing `});` of the existing `editor.view.dom.addEventListener('click', (ev) => { ... });` block (the delegated in-figure click handler that starts at line ~244), add:

```ts
  // Delegated pointer/keyboard reorder of figure thumbs. Self-contained:
  // a capture-phase click listener swallows the post-drag synthetic
  // click so the tap-to-edit handler above is unaffected.
  wireFigureReorder(editor);
```

- [ ] **Step 3: Verify the gate passes**

Run: `npm run check`
Expected: green. (Knip must not flag `wireFigureReorder` as unused now that it's called; if the `.ts`-less import trips a lint rule, add `.ts` to match.)

- [ ] **Step 4: Commit**

```bash
git add src/admin/main.ts
git commit -m "feat(figure-reorder): wire reorder into the editor"
```

---

### Task 6: Drag/focus styling (`admin-styles.ts`)

**Files:**
- Modify: `src/templates/admin-styles.ts` (the `.rkr-multi *` block is at lines ~78-83; the multi-actions button block ~291-320)

- [ ] **Step 1: Add the styles**

In `src/templates/admin-styles.ts`, add the following CSS **after** the existing `#rkroll-admin-article .rkr-multi, #rkroll-admin-article .rkr-multi * { ... }` rule (it ends at line ~83). Placement after that block matters: that rule sets `touch-action: pan-y` on `.rkr-multi *` (which includes thumbs) at equal specificity, so the override must come later in source order to win.

```css
  /* Reorder: thumb must claim the gesture (pan-y above would let the
     page scroll instead of letting the finger drag). */
  #rkroll-admin-article .rkr-multi-thumb { touch-action: none; }
  #rkroll-admin-article .rkr-multi-thumb:focus-visible {
    outline: 2px solid var(--rkr-link);
    outline-offset: 2px;
  }
  #rkroll-admin-article .rkr-multi-thumb.is-dragging {
    opacity: .4;
  }
  /* Insertion indicator: absolutely positioned inside the thumb grid
     (which must be a positioned ancestor for left/top to resolve). */
  #rkroll-admin-article .rkr-multi-thumbs { position: relative; }
  #rkroll-admin-article .rkr-multi-drop-indicator {
    position: absolute;
    background: var(--rkr-link);
    border-radius: 1px;
    pointer-events: none;
    z-index: 2;
  }
  /* Visually-hidden reorder status (announced via aria-live). */
  #rkroll-admin-article .rkr-multi-status {
    position: absolute; width: 1px; height: 1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
  }
```

- [ ] **Step 2: Verify the gate passes**

Run: `npm run check`
Expected: green (this file is a TS template literal; typecheck + biome only).

- [ ] **Step 3: Commit**

```bash
git add src/templates/admin-styles.ts
git commit -m "feat(figure-reorder): drag/focus/indicator styling"
```

---

### Task 7: End-to-end verification (Playwright)

**Files:**
- Create: `test/e2e/figure-reorder.spec.ts`

Use `test/e2e/editor-flow.spec.ts` as the template for the harness: it exports `login()`, inlines base64 1×1 PNGs, uploads them to build a figure, and selects thumbs via `page.locator('img[data-cell-index="N"]')`. Build a 3-image figure exactly the way `editor-flow.spec.ts` builds a multi-image figure (insert image, then use the `[data-add-image]` "+" affordance twice with the RED and BLUE PNGs), then save via the editor's Save and reload the post.

- [ ] **Step 1: Write the spec**

Create `test/e2e/figure-reorder.spec.ts`:

```ts
// E2E: figure image reorder. Drag persists across save; a stationary
// tap still opens per-cell edit; keyboard arrows reorder. Harness
// mirrors editor-flow.spec.ts (login + base64 PNG upload to build a
// multi-image figure).

import { expect, test } from './coverage-fixtures.ts';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';
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

async function uploadInto(page: import('@playwright/test').Page, selector: string, b64: string) {
  await page.locator(selector).setInputFiles({
    name: `${b64.slice(0, 6)}.png`,
    mimeType: 'image/png',
    buffer: Buffer.from(b64, 'base64')
  });
}

test('drag reorder moves a thumb and survives save; tap still edits', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor');

  // Build a 3-image figure (insert + add + add), the editor-flow.spec
  // way. Insert first image via the toolbar image button's file input.
  await page.getByRole('button', { name: /Insert image/i }).click();
  await uploadInto(page, 'input[type="file"]', PNG_BLACK);
  await expect(page.locator('img[data-cell-index="0"]')).toBeVisible();
  for (const png of [PNG_RED, PNG_BLUE]) {
    await page.locator('[data-add-image]').click();
    await uploadInto(page, 'input[type="file"]', png);
  }
  await expect(page.locator('img[data-cell-index="2"]')).toBeVisible();

  const ids = () =>
    page.$$eval('img[data-cell-index]', (els) =>
      els.map((e) => (e as HTMLImageElement).getAttribute('data-id'))
    );
  const before = await ids();

  // Drag thumb 0 past thumb 2 (Pointer Events via page.mouse).
  const a = await page.locator('img[data-cell-index="0"]').boundingBox();
  const c = await page.locator('img[data-cell-index="2"]').boundingBox();
  if (!a || !c) throw new Error('thumbs missing');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width + 6, c.y + c.height / 2, { steps: 12 });
  await page.mouse.up();

  await expect.poll(ids).not.toEqual(before);
  const after = await ids();
  expect(after).toEqual([before[1], before[2], before[0]]);

  // Save, reload the editor, confirm the new order persisted.
  await page.getByRole('button', { name: /^Save/ }).click();
  await page.waitForLoadState('networkidle');
  await page.reload();
  await expect.poll(ids).toEqual(after);

  // A stationary tap still opens per-cell edit (no reorder).
  const orderPreTap = await ids();
  await page.locator('img[data-cell-index="0"]').click();
  await expect(page.locator('#rkr-image-edit, .rkr-cell-dialog-body')).toBeVisible();
  expect(await ids()).toEqual(orderPreTap);
});

test('keyboard ArrowRight reorders a focused thumb', async ({ page }) => {
  await login(page);
  await page.goto('/admin/editor');
  await page.getByRole('button', { name: /Insert image/i }).click();
  await uploadInto(page, 'input[type="file"]', PNG_BLACK);
  await expect(page.locator('img[data-cell-index="0"]')).toBeVisible();
  await page.locator('[data-add-image]').click();
  await uploadInto(page, 'input[type="file"]', PNG_RED);
  await expect(page.locator('img[data-cell-index="1"]')).toBeVisible();

  const ids = () =>
    page.$$eval('img[data-cell-index]', (els) =>
      els.map((e) => (e as HTMLImageElement).getAttribute('data-id'))
    );
  const before = await ids();
  await page.locator('img[data-cell-index="0"]').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(ids).toEqual([before[1], before[0]]);
});
```

- [ ] **Step 2: Run the spec to verify it passes**

Run: `npx playwright test --config test/playwright.config.ts test/e2e/figure-reorder.spec.ts`
Expected: 2 tests PASS. (If the toolbar control names differ, align the role/name selectors with `test/e2e/editor-flow.spec.ts`'s image-insert flow — it is the authoritative example for this codebase.)

- [ ] **Step 3: Run the full gate**

Run: `npm run check`
Expected: green (unit suite unaffected; e2e ratchet picks up `src/admin/figure-reorder.ts`).

- [ ] **Step 4: Commit**

```bash
git add test/e2e/figure-reorder.spec.ts
git commit -m "test(figure-reorder): e2e drag + keyboard reorder, tap-still-edits"
```

---

### Task 8: Update DEFERRED.md (close v1, record fast-follow)

**Files:**
- Modify: `docs/DEFERRED.md` (the "Drag-and-drop image reordering in the figure editor" entry, ~lines 710-724)

- [ ] **Step 1: Edit the entry**

Replace the body of the "### Drag-and-drop image reordering in the figure editor" entry so it reflects that within-figure reorder shipped and only the cross-figure move remains deferred:

```markdown
### Cross-figure image move (drag an image between figures)

**Source.** User request, 2026-05-16. Within-figure reorder shipped
2026-05-16 (spec `2026-05-16-figure-reorder-design.md`, plan
`2026-05-16-figure-reorder.md`).

**What.** Drag an image from one figure into another, reusing the
`figure-reorder.ts` pointer-drag substrate.

**Why deferred.** Adds a single PM transaction patching *two* figure
nodes, deletion of an emptied source figure (today's code leaves
`ids=''`), a fixed-slot capacity rule for diptych (2) / triptych (3)
drop targets, and cross-figure hit-testing. Specced separately.

**Trigger.** First time an author wants an image moved between two
existing figures.
```

- [ ] **Step 2: Commit**

```bash
git add docs/DEFERRED.md
git commit -m "docs(deferred): close within-figure reorder; record cross-figure fast-follow"
```

---

## Self-Review Notes

- **Spec coverage:** interaction model (Tasks 3–6), pure permute + parallel-array re-pad (Task 1), hit-test (Task 2), keyboard a11y + aria-live (Tasks 3–4), `nodeDOM` commit (Task 4), `touch-action` override placement + indicator (Task 6), tap-unchanged via capture-phase suppression (Tasks 4–5, asserted in Task 7), cross-figure documented out (Task 8) — all mapped.
- **Type consistency:** `moveItem`, `reorderFigureCells`, `FigureCellArrays`, `dropIndexFor`, `wireFigureReorder` used with identical signatures across Tasks 1–5.
- **No placeholders:** every code step is complete and runnable.
- **Risk noted for executor:** e2e selector names (toolbar "Insert image", "Save") must match this codebase's editor; `test/e2e/editor-flow.spec.ts` is the authoritative reference and is called out in Task 7.
