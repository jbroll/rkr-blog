# Blocks Editor Surface — MVP Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin opens `/admin/blocks/edit/:slug` in a browser, sees a palette of macros plus primitives, inserts and rearranges blocks by drag (or keyboard), edits values inline, previews, and saves.

**Architecture:** Thin client over the existing JSON APIs: page JSON, macros list, save, plus one new preview-render endpoint. Tree ops stay pure and tested; DOM layer mounts palette, cards, fields, and HTML5 drag-and-drop.

**Tech Stack:** TypeScript, existing admin esbuild bundle, same-origin cookie session (token-login for staging), no new runtime deps.

**Spec:** `docs/superpowers/specs/2026-10-22-reusable-blocks-design.md` (palette interaction section, decided 2026-10-22)

## Global Constraints

- Work happens on `exp/reusable-blocks`; every task ends green (`typecheck`, `lint`, `knip:gate`, touched tests) and committed.
- Staging verification against `/tmp/opencode/rkr-blocks-bulk` on port 3010 after UI tasks.
- No new runtime dependencies. Browser code stays free of node:* imports.

## Review Focus

- Palette stays usable with an empty macro library (primitives always present).
- Every insert path honors depth-3-per-macro and the cycle guard at drop time.
- Failed saves surface an error in the UI; the tree state is never silently lost.
- Keyboard-only authors can insert, reorder, and delete without a pointer.
- Unsaved changes warn before the preview toggle or navigation discards them.

---

### Task 1: Staging access check

**Files:** none (verification only)

- [ ] **Step 1: Log in via token form.** POST `/admin/auth/token-login` with `token=stage-token-123`, keep the session cookie.
- [ ] **Step 2: Open the editor shell.** GET `/admin/blocks/edit/glasgow` with the cookie.
- [ ] **Step 3: Confirm palette data.** GET `/admin/blocks/macros` with the cookie; expect page/hero/cards-3/logo-wall.
- [ ] **Step 4: Record result.** If the shell loads and the macros list returns, access works and the "missing palette" was the auth wall.

**Model:** `haiku` — verification only.

### Task 2: Palette primitives plus double-click and Enter insert

**Files:**
- Modify: `src/admin/blocks-editor.ts`
- Modify: `src/admin/blocks-page-editor.ts`
- Test: `test/admin/blocks-page-editor.test.ts` (drive via ops where possible), plus DOM-level test where the harness allows

**Model:** `sonnet` — DOM wiring with judgment.

- [ ] **Step 1: Write the failing test.** Palette exposes primitives (text, figure, button, row, col, section) even when the macro list is empty; double-click and Enter trigger the same insert as click.
- [ ] **Step 2: Run test to verify it fails.**
- [ ] **Step 3: Implement.** Static `PRIMITIVE_MACROS` merged ahead of server macros in the mount; `dblclick` and keydown Enter call the same insert handler as click.
- [ ] **Step 4: Run test to verify it passes.**
- [ ] **Step 5: Gates plus commit.**

### Task 3: Drag from palette with drop indicators

**Files:**
- Modify: `src/admin/blocks-page-editor.ts`
- Test: extend `test/admin/blocks-page-editor.test.ts` (drop-target computation is pure: given a pointer position and card rects, return the target path and index)

**Model:** `sonnet` — pointer math with judgment.

- [ ] **Step 1: Write the failing test.** `dropTargetAt(rects, x, y)` returns `{ parentPath, index }` for before/after/inside cases; refuses drops that would exceed depth-3 or create a cycle.
- [ ] **Step 2: Run test to verify it fails.**
- [ ] **Step 3: Implement.** `draggable=true` palette items with `dragstart` carrying the macro name or primitive kind; card `dragover` shows an indicator line; `drop` inserts via `insertAtPath`.
- [ ] **Step 4: Run test to verify it passes.**
- [ ] **Step 5: Gates plus commit.**

### Task 4: Drag reorder across containers plus keyboard move

**Files:**
- Modify: `src/admin/blocks-page-editor.ts`
- Test: extend ops tests (already cover `moveNode`; add keyboard handler mapping)

**Model:** `sonnet` — interaction judgment.

- [ ] **Step 1: Write the failing test.** Cards are draggable; dropping a card on another container calls `moveNode`; Alt+Arrow (or documented keys) moves the selected card earlier/later, including across containers where legal.
- [ ] **Step 2: Run test to verify it fails.**
- [ ] **Step 3: Implement.** Reuse `moveNode`; illegal drops (own descendant, depth-3 breach) show a status note and change nothing.
- [ ] **Step 4: Run test to verify it passes.**
- [ ] **Step 5: Gates plus commit.**

### Task 5: Delete, save status, and dirty guard

**Files:**
- Modify: `src/admin/blocks-page-editor.ts`
- Test: extend ops/UI tests (delete via `removeAtPath`; dirty flag transitions)

**Model:** `sonnet` — state judgment.

- [ ] **Step 1: Write the failing test.** Selected card deletes via button and keyboard; save shows saved/error status; navigating with unsaved changes warns.
- [ ] **Step 2: Run test to verify it fails.**
- [ ] **Step 3: Implement.** Delete control per card plus Delete/Backspace key; status region for save results; `beforeunload` plus preview-toggle guard when dirty.
- [ ] **Step 4: Run test to verify it passes.**
- [ ] **Step 5: Gates plus commit.**

### Task 6: Live preview of the unsaved tree

**Files:**
- Create or modify: preview-render endpoint (route) plus client wiring
- Test: route test (valid tree renders HTML; invalid is 400) and client wiring test

**Model:** `sonnet` — server/client split.

- [ ] **Step 1: Write the failing test.** POST `/admin/blocks/preview-render` with a tree returns rendered HTML; invalid tree is 400.
- [ ] **Step 2: Run test to verify it fails.**
- [ ] **Step 3: Implement.** Endpoint reuses the page renderer with `{}` overrides against the site macro library; client preview pane posts the current state on demand (button plus debounce, not per keystroke).
- [ ] **Step 4: Run test to verify it passes.**
- [ ] **Step 5: Gates, staging verify, commit.**
