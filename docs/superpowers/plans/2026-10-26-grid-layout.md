# Grid Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `section`/`row`/`col`/`flow` with one `grid` container, enforce the hard rules on save, make drags show only legal slots, and re-import the legacy posts on the dev site.

**Architecture:** A new `src/lib/grid.ts` owns grid slots, shorthand expansion and labels; `blocks.ts` parses (lenient, expands shorthand) and a new `validateForSave` applies the hard rules. The renderer emits one grid markup whose CSS collapses by the grid's own width. The editor's drop logic moves to `src/admin/drop-slots.ts`, computing legal slots for the innermost grid; wrap/unwrap and a grid dialog are toolbar/configure additions.

**Tech Stack:** TypeScript (strip-types), Fastify, node:test with `test/admin/fake-dom.ts`, Playwright e2e, esbuild.

**Spec:** `docs/superpowers/specs/2026-10-26-grid-layout-design.md` (amends `docs/spec.md §8a`).

Worktree: `/home/john/src/rkr-blog-grid`, branch `feat/grid-blocks`. It already carries uncommitted drag work (drag ghost in `unified-block-actions.ts`, nearest-block drop, palette-name filter and native-drag block in `unified-insert.ts`, with tests). Task 1 commits it first.

## Global Constraints

- Production source (`src/`, `bin/`) files stay under 500 lines; tests are exempt.
- No new runtime dependencies.
- Authors never see raw JSON, block ids or image ids.
- One render path: edit markup comes from `renderBlockTree` with `mark`.
- Public pages keep their CSP. Per-grid values go in a `style` attribute (allowed: `style-src 'self' 'unsafe-inline'`, the same mechanism figures use for `--rkr-row-height`).
- UI copy is plain sentence case. Copy fixed by the spec is used verbatim: "Empty grid: drag blocks here"; "This block can't be saved: the macro NAME no longer exists. Delete it to save."; toolbar labels "Section", "Column", "Row (N columns)"; actions "Wrap in row", "Wrap in column", "Unwrap".
- Grid slot values: `cols` 1–6 (default 1); `min` `narrow`=10rem, `medium`=16rem (default), `wide`=24rem; `widths` space-separated positive numbers, used only with exactly `cols` entries; `band` boolean; `theme` existing section themes (default `light`); `edge` `straight`|`wave` (default `straight`).
- Depth: at most 3 grid levels from the page body (`MAX_MACRO_DEPTH` stays 3).
- Comments default to none; say why, 1–2 lines. Docs change in the same commit as code.
- Commit gate: lefthook, never `--no-verify`. Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:admin`, and the e2e specs you touched before committing. Commit trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Tests that build container trees directly (not through `parseBlockTree`) switch to `grid` in the task that changes the module they test.

## Review Focus

1. Existing JSON pages and the seed macros use shorthand (`section`, `row`, `col`, `flow`), including migrated posts wrapped in one `flow`; they must open, render with the same structure and keep their hero. Test in Task 2 (hero from a leading one-column grid) and Task 1 (shorthand expansion of each seed macro fixture).
2. A page holding a macro instance whose file was deleted must still open and render; its save is refused with the spec's message and the editor marks the block. Tests in Task 3 (route) and Task 5 (editor message).
3. A grid slot read from disk with garbage (`cols: 0`, `cols: "x"`, `widths: "1 1 1"` with `cols: 2`, unknown `min`) must not make the page vanish; it renders clamped. Test in Task 1 (parse keeps it) and Task 2 (render clamps).
4. A grid that has collapsed to one column on a narrow screen gets horizontal drop markers, not vertical. Test in Task 6 using rects that stack.
5. Wrapping a block that is already at depth 3, or dropping a grid that contains grids into a deep slot, is refused with the existing depth nudge. Tests in Task 6 (drop) and Task 7 (wrap).

---

### Task 1: Grid model, shorthand expansion, save validation

**Files:**
- Create: `src/lib/grid.ts`
- Modify: `src/lib/blocks.ts`
- Test: `test/lib/grid.test.ts` (new), `test/lib/blocks.test.ts`

**Model:** `sonnet` — model change with several rules from prose.

**Interfaces:**
- Produces (in `src/lib/grid.ts`):
  - `export type GridMin = 'narrow' | 'medium' | 'wide'`
  - `export const GRID_MIN_REM: Record<GridMin, number>` = `{ narrow: 10, medium: 16, wide: 24 }`
  - `export interface GridSlots { cols: number; min: GridMin; widths: number[] | null; band: boolean; theme: string; edge: 'straight' | 'wave' }`
  - `export function readGridSlots(slots: Slots | undefined): GridSlots` — clamps per the spec's "Reading" rules (`cols` non-integer or out of 1–6 → clamp, non-number → 1; unknown `min` → `medium`; `widths` ignored unless exactly `cols` positive numbers; `theme` must match `/^[a-z-]+$/` else `light`).
  - `export function gridSlotProblem(slots: Slots | undefined): string | null` — strict check for save (hard rule 6); returns a message naming the slot, or null.
  - `export function gridLabel(slots: Slots | undefined): string` — `band` → "Section", cols 1 → "Column", else `Row (${cols} columns)`.
  - `export function expandShorthand(node: Record<string, unknown>): Record<string, unknown>` — maps per the spec's shorthand table; `row` cols = `min(children.length, 6)` (at least 1); `flow`/`col` read `children ?? blocks`; leaves other types untouched.
- Produces (in `src/lib/blocks.ts`):
  - `ContainerKind` becomes `'grid'`; `ContainerNode` is `{ type: 'grid'; slots?: Slots; children: BlockNode[] }` (no `blocks`).
  - `parseBlockTree(json: unknown): BlockTree` expands shorthand recursively before type checks; out-of-range grid slots are kept as given (clamped only on render).
  - `export function validateForSave(tree: BlockTree, macroNames: ReadonlySet<string>): { path: number[]; message: string } | null` — hard rules 2–6 (rule 1 is parse). Messages: unknown macro → `This block can't be saved: the macro ${name} no longer exists. Delete it to save.`; empty figure → `An image block has no images.`; video with no `ids` → `A video block has no video.`; depth → `Grids nest at most 3 levels.`; slot → `gridSlotProblem` text.
  - `containerDepth` counts `grid`.

- [ ] **Step 1: Commit the carried drag work.** Run the gate checks; commit `src/admin/unified-block-actions.ts`, `src/admin/unified-insert.ts`, `test/admin/unified-block-actions.test.ts`, `test/admin/unified-shell.test.ts` as "editor: drag ghost, nearest-block drop, palette-only drops". Add this spec and plan in the same commit.
- [ ] **Step 2: Write failing tests** in `test/lib/grid.test.ts`: each shorthand row of the spec table (`section` with theme dark/edge wave → `{type:'grid', slots:{band:true,theme:'dark',edge:'wave',cols:1}}`; `row` with 8 children → cols 6; `flow` with `blocks` → grid children); `readGridSlots({cols:0})` → cols 1, `{cols:9}` → 6, `{cols:'x'}` → 1, `{cols:2,widths:'1 1 1'}` → widths null, `{cols:2,widths:'2 1'}` → [2,1], `{min:'huge'}` → medium; `gridSlotProblem({cols:7})` non-null, `({cols:2,widths:'2 x'})` non-null, `({cols:2,widths:'2 1'})` null; `gridLabel` three cases. In `test/lib/blocks.test.ts`: parsing each fixture in `test/fixtures/blocks/*.json` (`tree` field) yields only `grid` containers; a page with `{type:'grid', slots:{cols:'x'}}` parses; `validateForSave` returns the exact message and path for an unknown macro at `[1,0]`, an empty figure, a 4-deep grid, and null for a valid tree.
- [ ] **Step 3: Run** `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/lib/grid.test.ts test/lib/blocks.test.ts` — expect FAIL.
- [ ] **Step 4: Implement** `src/lib/grid.ts` and the `blocks.ts` changes above. The renderer, tree ops and migrator are reworked in Tasks 2, 4 and 5; here change only what `npm run typecheck` and `npm test` require. Container type checks become `'grid'`. The renderer gets an interim `grid` case that reproduces today's markup (band → the old section markup, `cols` 1 → `<div class="rkr-col">`, otherwise `<div class="rkr-row">`), so pages look unchanged until Task 2 replaces it.
- [ ] **Step 5: Run** the two test files — expect PASS; then `npm test` and fix tests that built shorthand trees directly against modules this task changed.
- [ ] **Step 6: Commit** "blocks: grid container, shorthand expansion, save validation".

### Task 2: Render grids and hero rule

**Files:**
- Modify: `src/lib/blocks-render.ts`, `src/lib/block-teaser.ts`, `src/lib/block-post-render.ts` (if it selects the hero), `static/themes/default.css`, `src/templates/admin-editor-styles.ts`
- Test: `test/lib/blocks-render.test.ts`, `test/lib/block-teaser.test.ts`, `test/routes/public-block-post.test.ts`

**Model:** `sonnet` — markup and CSS from prose.

**Interfaces:**
- Consumes: `readGridSlots`, `GRID_MIN_REM`, `gridLabel` (Task 1).
- Produces markup:
  - Non-band: `<div class="rkr-grid" style="--rkr-grid-cols:N;--rkr-grid-min:Mrem[;--rkr-grid-widths:Afr Bfr]"[ data-widths]>…children…</div>`.
  - Band: `<section class="rkr-section rkr-theme-T">\n<div class="rkr-section-inner rkr-grid" style="…">…</div>[wave]\n</section>` (keeps existing section CSS and wave).
  - Empty grid: public render returns `''`; marked render returns the grid element containing `<p class="rkr-grid-empty" data-rkr-grid-empty>Empty grid: drag blocks here</p>`.
  - Marked render adds `data-rkr-grid-label="${gridLabel}"` on the grid element (used by editor CSS `::before { content: attr(data-rkr-grid-label) }`).

- [ ] **Step 1: Write failing tests:** a `cols:3` grid renders `--rkr-grid-cols:3` and `--rkr-grid-min:16rem`; `cols:2, widths:'2 1'` renders `--rkr-grid-widths:2fr 1fr` and `data-widths`; `cols:'x'` renders `--rkr-grid-cols:1`; band with theme dark/edge wave renders `rkr-section rkr-theme-dark` and the wave div; empty grid public → no `rkr-grid` in output, marked → placeholder text; a page whose body is `[{type:'flow', blocks:[figure, text]}]` (shorthand) picks the figure as hero (teaser and public post), same as a body starting with a figure.
- [ ] **Step 2: Run** those test files — FAIL.
- [ ] **Step 3: Implement** the `grid` case and remove the four old cases. CSS in `default.css`, replacing `.rkr-row`, `.rkr-col`, `.rkr-flow` rules (keep `.rkr-section*` and `.rkr-theme-*`):

```css
.rkr-grid {
  display: grid;
  gap: var(--rkr-gap);
  /* Caps at --rkr-grid-cols, drops a column whenever a cell would fall below --rkr-grid-min. */
  grid-template-columns: repeat(auto-fill, minmax(max(var(--rkr-grid-min, 16rem), (100% - (var(--rkr-grid-cols, 1) - 1) * var(--rkr-gap)) / var(--rkr-grid-cols, 1)), 1fr));
  min-width: 0;
}
.rkr-grid > * { min-width: 0; }
.rkr-grid[data-widths] { grid-template-columns: var(--rkr-grid-widths); }
```

  Equal-width grids collapse through the `minmax(max(…))` rule above, which measures the grid itself. Grids with `widths` cannot use it, and CSS container conditions cannot read custom properties, so: the renderer wraps a `widths` grid in `<div class="rkr-grid-wrap">` (`container-type: inline-size`) and adds class `rkr-collapse-N-M` (N = cols 2–6, M = `narrow|medium|wide`); `default.css` carries the 15 rules `@container (max-width: W) { .rkr-collapse-N-M { grid-template-columns: 1fr; } }` with W = N × min rem + (N − 1) × 1.5rem. Inline `style` attributes are allowed by the public CSP (`style-src 'self' 'unsafe-inline'`). Move any `.rkr-row`/`.rkr-col` rules in the other seven themes to `.rkr-grid`. Editor styles: replace the `.rkr-row,.rkr-col,.rkr-flow` outline/label rules with `.rkr-grid[data-rkr-path]` and `content: attr(data-rkr-grid-label)`; style `.rkr-grid-empty` as a dashed drop area.
- [ ] **Step 4: Run** the tests — PASS; run `npm test`, `npm run build:admin`, `npm run test:e2e -- public-figures blocks-unified` and fix e2e selectors that used `.rkr-row`/`.rkr-col`.
- [ ] **Step 5: Screenshot check** (Playwright, 1280 and 390 px wide) of a page with a `cols:3` grid of three figures, a `cols:2 widths:'2 1'` grid, and a band; confirm 3→1 column collapse at 390 px and the 2:1 grid stacking. Note the screenshot paths in the report.
- [ ] **Step 6: Commit** "render: grid markup and CSS; hero from a leading one-column grid".

### Task 3: Save route enforces the hard rules

**Files:**
- Modify: `src/routes/admin-blocks.ts`, `src/lib/macro-library.ts` (expose names)
- Test: `test/routes/admin-blocks.test.ts`

**Model:** `sonnet` — route wiring plus tests.

**Interfaces:**
- Consumes: `validateForSave` (Task 1).
- Produces: `POST /admin/blocks/:slug` and `POST /admin/blocks/new` respond `400 { error: 'invalid', message, path }` from `validateForSave`; the macro library exposes `macroNames(siteRoot): ReadonlySet<string>` (or the existing loader's keys — use what `macro-library.ts` already returns; do not load twice per request).

- [ ] **Step 1: Write failing tests:** saving a tree with `{type:'macro', macro:'gone'}` → 400 with the spec message and `path: [0]`, file unchanged; saving an empty figure → 400; saving a 4-deep grid → 400; saving shorthand (`row` with two texts) → 200 and the stored file contains `"type": "grid"` and no `"row"`; `GET /admin/blocks/edit/:slug` for a stored page with an unknown macro → 200 (opens).
- [ ] **Step 2: Run** `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/routes/admin-blocks.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Store the parsed (expanded) tree, never the request JSON.
- [ ] **Step 4: Run** — PASS; `npm test`.
- [ ] **Step 5: Commit** "admin-blocks: reject trees that break the hard rules".

### Task 4: Migration writes grids and no wrapper

**Files:**
- Modify: `src/lib/markdown-migrate.ts`, `src/lib/wp-import-emit.ts`
- Test: `test/lib/markdown-migrate.test.ts`, `test/cli/blocks-migrate.test.ts`, `test/cli/import-wp-blocks.test.ts`

**Model:** `sonnet` — converter change.

**Interfaces:**
- Produces: `markdownToTree` (existing name in `markdown-migrate.ts`; keep it) returns `body` = the converted blocks directly (no `flow`); a directive container that produced `section` now produces `{type:'grid', slots:{band:true, theme:'light', edge:'straight', cols:1}, children}`; `wp-import-emit.ts` emits `grid` for what it emitted as `section`.

- [ ] **Step 1: Write failing tests:** converting a post with a leading `::figure` and two paragraphs gives `body[0].type === 'figure'` and `body.length === 3`; the section-producing directive case gives a band grid; `--all` output contains no `"flow"`, `"section"`, `"row"` or `"col"`.
- [ ] **Step 2: Run** the three test files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `npm test`.
- [ ] **Step 5: Commit** "migrate: blocks straight into the page body, grids for sections".

### Task 5: Editor tree ops, palette presets, labels, media-first insert, unsavable blocks

**Files:**
- Modify: `src/admin/block-tree-ops.ts`, `src/admin/blocks-editor.ts`, `src/admin/block-move.ts` (if it names containers), `src/admin/unified-block-actions.ts` (`typeLabel`), `src/admin/unified-shell.ts`, `src/admin/unified-save.ts` (400 handling)
- Test: `test/admin/block-tree-ops.test.ts`, `test/admin/blocks-editor.test.ts`, `test/admin/block-move.test.ts`, `test/admin/unified-shell.test.ts`, `test/admin/unified-block-actions.test.ts`

**Model:** `opus` — shell insert/save flow changes with data-safety edges.

**Interfaces:**
- Consumes: `gridLabel` (Task 1); save 400 shape (Task 3).
- Produces:
  - `primitiveNode('primitive:row')` → `{type:'grid', slots:{cols:2}, children:[]}`; `'primitive:col'` → `{type:'grid', slots:{cols:1}, children:[]}`; `'primitive:section'` → `{type:'grid', slots:{cols:1, band:true, theme:'light', edge:'straight'}, children:[]}`. Palette labels stay Row, Column, Section.
  - `typeLabel` for a grid node returns `gridLabel(node.slots)`.
  - Media-first insert: inserting `primitive:figure`/`primitive:video` (click or drop) renders the block and opens the picker but does not save or draft until the dialog commits ids; Cancel removes the block and re-renders, saving nothing.
  - Save 400 `{error:'invalid', message, path}`: the shell selects the block at `path`, shows `message` in the toolbar note (the existing `noteFor` channel), sets the indicator to unsaved, and does not retry until the tree changes.

- [ ] **Step 1: Write failing tests:** tree ops insert/remove/resolveDrop on `grid` (inside → end of grid; leaf → null); `primitiveNode` presets above; label for each preset; inserting an Image then Cancel → zero saves, block gone; inserting then picking → exactly one save containing the ids; a save answered 400 with `path:[1]` selects `[1]` and shows the message; editing another block clears the note and saves again.
- [ ] **Step 2: Run** those test files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `npm test`; `npm run build:admin`; `npm run test:e2e -- blocks-unified`.
- [ ] **Step 5: Commit** "editor: grid presets and labels, media-first insert, unsavable block notice".

### Task 6: Legal drop slots

**Files:**
- Create: `src/admin/drop-slots.ts`
- Modify: `src/admin/unified-insert.ts` (move `dropTarget` and helpers out; keep event wiring)
- Test: `test/admin/drop-slots.test.ts` (new), `test/admin/unified-shell.test.ts`

**Model:** `opus` — geometry plus legality rules.

**Interfaces:**
- Consumes: tree ops (Task 5), `readGridSlots` (Task 1), `MAX_MACRO_DEPTH`.
- Produces:
  - `export interface DropSlot { parentPath: Path; index: number; anchor: Element | null; side: 'before' | 'after' | 'inside'; axis: 'horizontal' | 'vertical' }` — `axis` is the marker line's orientation: `vertical` when the neighbours sit side by side.
  - `export function findDropSlot(body: Element, tree: BlockTree, x: number, y: number, hovered: Element | null, dragged: BlockNode, from: Path | null): DropSlot | null`.
  - `unified-insert.ts` marks the anchor with `data-drop="before|after|inside"` and `data-drop-axis="horizontal|vertical"`; editor CSS draws a horizontal or vertical bar from `data-drop-axis`. A null slot means no `preventDefault` in dragover (cursor shows refusal).
- Rules (spec "Dragging" and "Soft rules"): innermost grid under the pointer, else page body; slots are gaps between its cells in reading order plus ends; nearest slot by distance from the pointer to the gap; empty grid → `inside`; axis from the live rects of the two neighbours (side by side if their vertical ranges overlap); refuse: into own subtree, a no-op move, a band grid anywhere but page level, a `cols:1` grid directly into a `cols:1` grid, any drop that makes depth exceed 3.

- [ ] **Step 1: Write failing tests** (fake DOM with stubbed rects): two cells side by side at y 0–100, pointer between → axis vertical, index 1; the same two cells stacked (collapsed) → axis horizontal; pointer in the gap below a paragraph inside a page-level grid → after that paragraph, not the grid's top; empty grid → inside; band grid dragged over a slot inside a grid → null; `cols:1` grid over a `cols:1` grid slot → null; a grid holding a grid dragged into a depth-2 grid → null; dropping a block onto its own slot → null.
- [ ] **Step 2: Run** `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/admin/drop-slots.test.ts` — FAIL.
- [ ] **Step 3: Implement** and rewire `unified-insert.ts`; keep the existing drag ghost, palette-name filter and native-drag block.
- [ ] **Step 4: Run** — PASS; `npm test`; `npm run build:admin`; `npm run test:e2e -- blocks-unified`; add one e2e in `blocks-unified.spec.ts`: drag a Text from the palette into the free column of a `cols:2` grid holding one figure, and it lands as the grid's second child.
- [ ] **Step 5: Commit** "editor: drops land only in legal slots, with axis-aware markers".

### Task 7: Wrap, unwrap and the grid dialog

**Files:**
- Create: `src/admin/grid-dialog-tree.ts`
- Modify: `src/admin/unified-block-actions.ts`, `src/admin/unified-configure.ts`, `src/admin/block-tree-ops.ts`
- Test: `test/admin/grid-dialog-tree.test.ts` (new), `test/admin/unified-block-actions.test.ts`, `test/admin/block-tree-ops.test.ts`

**Model:** `sonnet` — dialog following the button/macro dialog pattern.

**Interfaces:**
- Produces:
  - `export function wrapAtPath(tree: BlockTree, path: Path, cols: 1 | 2): BlockTree` and `export function unwrapAtPath(tree: BlockTree, path: Path): BlockTree` in `block-tree-ops.ts`.
  - Toolbar buttons "Wrap in row", "Wrap in column" (any block; hidden for a `cols:1` grid's "Wrap in column" when the parent is `cols:1`, per the soft rule), "Unwrap" (grids only). Wrap past depth 3 shows the existing depth nudge and changes nothing. Selection after wrap: the new grid; after unwrap: the first lifted child (none if empty).
  - `openGridDialog(...)` in `grid-dialog-tree.ts` with fields per spec "Configure a grid": Columns 1–6, Narrowest cell (Narrow, Medium, Wide), Column widths (Equal or ratio field for 2–4 columns, validated by `gridSlotProblem`), Full-width band checkbox, Background (theme list from the existing section theme select), Bottom edge (Straight, Wave). `CONFIGURABLE` gains `grid`.

- [ ] **Step 1: Write failing tests:** wrap then unwrap returns the original tree; wrap at depth 3 → unchanged and nudge; unwrap of an empty grid removes it; dialog commits `{cols:3, min:'wide'}`; widths `2 x` keeps the dialog open with the slot message; band off removes `theme`/`edge`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `npm test`; `npm run build:admin`; `npm run test:e2e -- blocks-unified`.
- [ ] **Step 5: Commit** "editor: wrap, unwrap and grid settings".

### Task 8: Docs and cleanup

**Files:**
- Modify: `docs/spec.md §8a` (Blocks table, rows/columns paragraph, hero rule, editor bullets for selecting/palette/dragging/dialogs, Saving 400 rule), `docs/implementation.md §8a`, `docs/DEFERRED.md` (span cells; figure merge), `macros/*.json` only if a seed breaks validation (they stay shorthand)
- Delete: `docs/superpowers/specs/2026-10-26-grid-layout-design.md`, `docs/superpowers/plans/2026-10-26-grid-layout.md`

**Model:** `sonnet` — docs synthesis.

- [ ] **Step 1:** Fold the spec into `docs/spec.md §8a` and `docs/implementation.md` (module map: `grid.ts`, `drop-slots.ts`, `grid-dialog-tree.ts`).
- [ ] **Step 2:** Add DEFERRED lines: spanning cells (_revisit when:_ an author needs a wide cell over two small ones); figure merge prompt (_revisit when:_ authors build rows of single-image figures).
- [ ] **Step 3:** Delete the spec and plan; full gate (`npm test`, full `npm run test:e2e`).
- [ ] **Step 4: Commit** "docs: grid layout in spec and implementation; drop working spec and plan".

### Task 9 (controller): Re-import legacy posts on the dev site

Not dispatched; the controller runs it after the final review.

- [ ] `npm run build:admin` in the worktree.
- [ ] `env SITE_ROOT=/tmp/opencode/rkr-blocks-bulk <worktree>/bin/site-admin blocks-migrate --all --force`, then `reindex`.
- [ ] Restart the single dev server on :3010 from the worktree (`ADMIN_TOKEN=probe-token`).
- [ ] Probe `glasgow` and `one-final-day`: no `rkr-flow` in markup, figures and text at page level, a drag between two paragraphs marks a horizontal slot.
