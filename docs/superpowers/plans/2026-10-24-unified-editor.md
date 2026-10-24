# Unified Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tree-view MVP with a unified editor: the left side is the live page (view/edit modes on one DOM), the right side is the palette; text edits in place, figures use dialogs, blur saves with an explicit Save button and dirty indicator.

**Architecture:** The server renders the exact public block HTML into the edit page plus invisible path-marker comments and the canonical tree JSON; the client hydrates markers to tree paths (no second renderer, no iframe, no framing fight). All writes reuse `POST /admin/blocks/:slug`, `setSlotAtPath` tree ops, and the existing outbox save path.

**Tech Stack:** TypeScript (Node >=22), Fastify inject tests, esbuild admin bundle, existing TipTap-free tree ops in `src/admin/blocks-page-editor.ts`.

**Spec:** `docs/superpowers/specs/2026-10-23-unified-editor-design.md`

## Global Constraints

- Work happens on `exp/reusable-blocks`; each task ends green (`typecheck`, `lint`, `knip:gate`, touched tests) and committed.
- Node >=22.0.0; no new runtime dependencies.
- Public pages keep `frame-ancestors 'none'` + `X-Frame-Options: DENY` unchanged; public render output must stay byte-identical unless a test pins the change.
- Slugs are stable across edits; comment threads, legacy permalinks, and `/pages/:slug` URLs must not break.
- Never expose raw JSON, fences, block ids, or hex image ids to authors in the editing surface.

## Review Focus

- A blur during an in-flight save must not lose either edit (last-writer-wins per widget with in-flight guard, never silent drop).
- Markdown round-trip fidelity: bold, links, lists, headings, and code edited in place must survive blur-save-reload byte-identical.
- A figure dialog save must write exactly the dialog's slots and nothing else (no dropped `alts`, no invented keys).
- A palette drop must land at the indicated path, never one sibling off, and containers must refuse a 4th level with the depth nudge.
- Offline edits must queue in the outbox and sync, with the indicator showing unsaved until drained.

---

### Task 1: Path-marked server render

**Files:**
- Modify: `src/lib/blocks-render.ts` (add marker hook)
- Modify: `src/routes/admin-blocks.ts` (`GET /admin/blocks/edit/:slug` embeds tree JSON + markers)
- Modify: `src/templates/admin-blocks-edit.ts` (mount point carries embedded tree)
- Test: `test/lib/blocks-render.test.ts` (new or extend), `test/routes/admin-blocks.test.ts`

**Model:** `sonnet` — renderer surgery with byte-identical public output.

**Interfaces:**
- Consumes: `renderBlockTree(tree, ctx, lib)` (existing), `readBlockPage` (existing).
- Produces: `renderBlockTree(tree, ctx, lib, opts?: { mark?: (path: number[]) => string })`; edit page HTML containing `<!--rkr:path=i,j,…-->` markers plus `<script type="application/json" id="rkr-tree">`.

- [ ] **Step 1: Write the failing test**

```ts
// test/lib/blocks-render.test.ts
test('markers zip with source order, public output unchanged without mark', async () => {
  // render fixture tree twice: once plain, once with mark: (p) => `<!--rkr:path=${p.join(',')}-->`
  // expect plain output === today's golden output byte-for-byte
  // expect stripping comments from marked output === plain output
  // expect marker paths in order === [0],[1],[2,0],[2,1] for section>row>col nesting
});
test('macro instance emits one marker (internals unmarked)', async () => {
  // tree with a macro instance: exactly one marker for the macro path
});
test('empty text emits no marker', async () => {
  // text with markdown '' produces no marker; sibling paths still zip
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types --conditions=development test/lib/blocks-render.test.ts`
Expected: FAIL (`mark` option does not exist)

- [ ] **Step 3: Implement marker hook in `renderBlockTree` in `src/lib/blocks-render.ts`**

Thread `path: number[]` through `renderNode`; when `opts.mark` is set, prepend `opts.mark(path)` to each node's HTML, except nodes rendering `''` emit nothing. Macro instances emit exactly one marker for the instance path; expansion internals render unmarked. Default (no `opts`) output must be byte-identical to today.

- [ ] **Step 4: Embed tree + markers in the edit route**

In `GET /admin/blocks/edit/:slug` (`src/routes/admin-blocks.ts`), render the page body with the marker hook (same `renderPage` pipeline as `/pages/:slug`: macro library, image/video maps, widget dispatch) and embed the canonical tree as `<script type="application/json" id="rkr-tree">`. Extend `renderBlocksEditPage` (`src/templates/admin-blocks-edit.ts`) with a `bodyHtml` + `treeJson` slot. Route test asserts the edit page contains `rkr:path=` markers and the embedded tree for a fixture slug.

- [ ] **Step 5: Run test to verify it passes**

Run: same command as Step 2 plus `test/routes/admin-blocks.test.ts`
Expected: PASS, plus full `test/routes/*.test.ts` still PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/blocks-render.ts src/routes/admin-blocks.ts src/templates/admin-blocks-edit.ts test/lib/blocks-render.test.ts test/routes/admin-blocks.test.ts
git commit -m "feat: path-marked server render for unified editor"
```

### Task 2: Edit shell with View/Edit modes and right palette dock

**Files:**
- Create: `src/admin/unified-shell.ts` (mode toggle, palette dock, hydration zip)
- Modify: `src/admin/blocks-page-editor-entry.ts` (mount shell instead of tree view)
- Modify: `src/templates/admin-blocks-edit.ts` (toggle + dock mount points, mode CSS classes)
- Test: `test/admin/unified-shell.test.ts` (DOM-level, happy-dom style used by repo admin tests)

**Model:** `sonnet` — DOM shell work with repo test patterns.

**Interfaces:**
- Consumes: embedded `#rkr-tree` JSON + `rkr:path` markers from Task 1; `mountBlocksPalette` from `src/admin/blocks-editor.ts`; `kids()` ordering (macro = leaf).
- Produces: `mountUnifiedShell(root, deps: { tree: BlockTree; macros: PaletteMacro[]; onSave(tree: BlockTree): Promise<void> })` with `{ setMode('view'|'edit'), selectedPath }`; palette docked right via `rkr-blocks-palette-right`.

- [ ] **Step 1: Write the failing test**

```ts
// test/admin/unified-shell.test.ts
test('hydration zips markers to tree paths in order', () => {
  // mount shell on fixture HTML with 3 markers; expect click on 2nd node selects path [1]
});
test('view mode hides palette and disables editing', () => {
  // setMode('view'): palette hidden, no contenteditable, no config buttons
});
test('edit mode shows palette and arms text leaves', () => {
  // setMode('edit'): palette visible, text leaves contenteditable, figure shows config button
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ... test/admin/unified-shell.test.ts`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement `mountUnifiedShell` in `src/admin/unified-shell.ts`**

Read `#rkr-tree`, collect `<!--rkr:path-->` comments in document order, zip with source-tree flattening (same order as server: skip empty text, macro = single unit). View/Edit toggle flips `data-mode` on the shell; palette mounts once via `mountBlocksPalette` into the right dock; config buttons render on hover/focus only for figure/macro/button leaves with dialogs.

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/admin/unified-shell.ts src/admin/blocks-page-editor-entry.ts src/templates/admin-blocks-edit.ts test/admin/unified-shell.test.ts
git commit -m "feat: unified edit shell with view/edit modes"
```

### Task 3: Type-in-place text editing with blur save

**Files:**
- Create: `src/admin/dom-markdown.ts` (DOM → text-DSL serializer)
- Modify: `src/admin/unified-shell.ts` (contenteditable, blur wiring, Save button, dirty indicator)
- Modify: `src/admin/blocks-page-editor-entry.ts` (savePage via existing POST, reindex already server-side)
- Test: `test/admin/dom-markdown.test.ts`, extend `test/admin/unified-shell.test.ts`

**Model:** `sonnet` — serializer judgment for the text DSL subset.

**Interfaces:**
- Consumes: `setSlotAtPath` (existing tree op), `POST /admin/blocks/:slug` (existing, whole-tree write).
- Produces: `domToMarkdown(el: Element): string`; shell states `clean | editing | saving | unsaved`.

- [ ] **Step 1: Write the failing test**

```ts
// test/admin/dom-markdown.test.ts
test('round-trips bold, links, lists, headings, code', () => {
  // for each of 5 fixtures: markdown -> renderPostHtml -> domToMarkdown === input (normalized)
});
test('blur during in-flight save keeps the newer edit', async () => {
  // two rapid blurs with deferred save: second save wins, indicator ends clean, one 400-free sequence
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ... test/admin/dom-markdown.test.ts`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement `domToMarkdown` in `src/admin/dom-markdown.ts`**

Serialize the text-DSL subset only: paragraphs, bold/italic, links (href preserved via `safeLinkUrl` rules), lists, headings, inline code, fenced code. Anything outside the subset escapes as literal text, never dropped. Wire blur in the shell: serialize → `setSlotAtPath` markdown → save whole tree → indicator `saving` → `clean`; on failure `unsaved` with retry on next blur/Save.

- [ ] **Step 4: Queue offline saves in the outbox**

Reuse the existing outbox (`src/admin/outbox.ts`, drainers): when the save POST throws or the browser is offline, enqueue the whole-tree write and set the indicator to `unsaved`; the existing drain syncs on reconnect and the indicator returns to `clean`. Test: `offline blur queues the write and marks unsaved` (stub fetch to reject, then resolve on retry; expect one POST total after drain, indicator `clean`).

- [ ] **Step 5: Run test to verify it passes**

Run: same command as Step 2 plus shell tests
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/admin/dom-markdown.ts src/admin/unified-shell.ts src/admin/blocks-page-editor-entry.ts test/admin/dom-markdown.test.ts test/admin/unified-shell.test.ts
git commit -m "feat: type-in-place text editing with blur save"
```

### Task 4: Config buttons and figure dialog on tree paths

**Files:**
- Modify: `src/admin/unified-shell.ts` (config button wiring)
- Modify: `src/admin/figure-attr-panel.ts` (decouple from TipTap `Editor`, drive from tree path) or create `src/admin/figure-dialog-tree.ts` if decoupling is invasive
- Test: `test/admin/figure-dialog-tree.test.ts` (new) or extend existing figure tests; e2e `test/e2e/blocks-unified.spec.ts` (new, seeds via `seed-blocks.ts`)

**Model:** `opus` — broad decoupling judgment across TipTap-bound dialog code.

**Interfaces:**
- Consumes: `setSlotAtPath`, shell `selectedPath`, existing dialog DOM + image pipeline (`canvas-loaders`, `image-map-opfs`).
- Produces: figure dialog opening from a tree path and committing exactly the dialog's slots via the standard save path.

- [ ] **Step 1: Write the failing test**

```ts
test('figure dialog commits only its slots', async () => {
  // open dialog for a figure path, change caption + alt, commit
  // expect tree slots updated, sibling nodes untouched, save POSTed once
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ... test/admin/figure-dialog-tree.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement tree-backed figure dialog**

Reuse the dialog open/populate/commit flow and the image pipeline; replace every `editor.chain()` transaction with `setSlotAtPath` + the shell save. If a panel function cannot work without a TipTap `Editor`, split it: tree-capable logic stays, TipTap calls move behind a two-line adapter documented in code.

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2 plus e2e spec if runnable
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: figure config dialog on tree paths"
```

### Task 5: Palette drag/click insert into the live page

**Files:**
- Modify: `src/admin/unified-shell.ts` (drop targets on live nodes, click-to-append)
- Test: extend `test/admin/unified-shell.test.ts`; e2e `test/e2e/blocks-unified.spec.ts`

**Model:** `sonnet` — reuses proven `resolveDrop`/`insertAllowed` semantics.

**Interfaces:**
- Consumes: `insertAtPath`, `resolveDrop`, `insertAllowed`, `depthLabel`, `primitiveNode` (all existing).
- Produces: drops landing at the indicated path with the depth nudge on refusal.

- [ ] **Step 1: Write the failing test**

```ts
test('drop on a live node inserts at the resolved path', () => {
  // drop figure primitive after text path [0]; expect tree body [text, figure], save POSTed
});
test('container refused at depth 3 with nudge', () => {
  // drop section into a depth-3 macro page; expect refusal + "save inner part as its own macro" copy
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ... test/admin/unified-shell.test.ts`
Expected: FAIL (no drop handling on live nodes)

- [ ] **Step 3: Implement drop/click insert in the shell**

Reuse `resolveDrop` before/after/inside semantics from the tree-view editor; visual drop marks on live nodes; click appends at end of the focused container (or page body). Refusals surface `depthLabel` + the save-inner-part nudge.

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/admin/unified-shell.ts test/admin/unified-shell.test.ts test/e2e/blocks-unified.spec.ts
git commit -m "feat: palette insert into live page"
```

### Task 6: Macro cards with field editors

**Files:**
- Modify: `src/admin/unified-shell.ts` (macro card label + config button → fields dialog)
- Test: extend `test/admin/unified-shell.test.ts`; fixtures in `test/e2e/blocks-unified.spec.ts`

**Model:** `sonnet` — same dialog pattern as Task 4, smaller surface.

**Interfaces:**
- Consumes: macro library names from `loadMacros`, `resolveSlots` defaults, Task 4 dialog plumbing.
- Produces: macro instance renders its label; config opens field editors per macro defaults; overrides save as instance slots.

- [ ] **Step 1: Write the failing test**

```ts
test('macro config edits overrides without touching defaults', () => {
  // open hero macro fields, change heading, save; expect instance slots {heading}, defaults intact
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ... test/admin/unified-shell.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement macro field editing**

Field editors per macro default keys (text inputs; rich text only for `text`-slot-shaped values). Unset stays unset (follows defaults); duplicate copies overrides via `duplicateOverrides`.

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/admin/unified-shell.ts test/admin/unified-shell.test.ts test/e2e/blocks-unified.spec.ts
git commit -m "feat: macro cards with field editors"
```

### Task 7: Retire tree-view UI, e2e pass, docs

**Files:**
- Delete: tree card UI in `src/admin/blocks-page-editor.ts` (keep pure tree ops: `getAtPath`, `setSlotAtPath`, `insertAtPath`, `removeAtPath`, `moveNode`, `resolveDrop`)
- Delete: preview iframe path in `src/admin/blocks-page-editor-entry.ts` (renderPreview) once nothing references it
- Modify: `docs/RUNBOOK.md` (editor section describes unified flow), `test/e2e/blocks-unified.spec.ts` (full flow: type, figure dialog, palette drop, save, reload, phone-width note)
- Test: full `npm test` + `test:e2e` blocks spec

**Model:** `sonnet` — deletion with proof nothing references the removed code.

**Interfaces:**
- Consumes: everything above.
- Produces: no references to `renderCard`, `mountBlocksPageEditor`, or `renderPreview`; e2e proves type→dialog→drop→save→reload.

- [ ] **Step 1: Write the failing test**

```ts
// test/e2e/blocks-unified.spec.ts
test('unified flow: type, dialog, drop, save, reload', async ({ page }) => {
  // seed hello via seed-blocks; type in text leaf; open figure dialog, change caption;
  // drag Image primitive; Save; reload; expect all three changes rendered
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:e2e -- blocks-unified`
Expected: FAIL (flow incomplete)

- [ ] **Step 3: Delete obsolete tree-view UI + iframe preview**

Remove `renderCard`, `mountBlocksPageEditor`, `renderPreview`, label/summary card code; keep and re-export the pure tree ops. Prove with `grep -rn` zero references (add the paths to the existing retired-routes guard test if it fits, else a comment).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test` (full) plus the e2e spec
Expected: PASS, 0 references to removed code

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: retire tree-view UI after unified editor cutover"
```
