# Unified Editor Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the unified block editor from a working prototype to the only editor authors need: every block can be added, edited, moved and removed without seeing ids or reloading, media comes from the same sources the old editor offered, page settings are editable, and the UI is designed rather than default-styled.

**Architecture:** The server stays the only renderer. Every structural change sends the tree to a new render endpoint and swaps the returned marked HTML into the page body, then re-hydrates. That replaces both the full-page reload and the client-side placeholders, which is where the stale-path bugs come from. Dialogs share one styled dialog component. The legacy TipTap bundle is retired at the end.

**Tech Stack:** TypeScript (strip-types), Fastify, esbuild admin bundle, node:test unit tests with fake DOM, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-23-unified-editor-design.md` (goals, anti-goals). Baseline bugs and UI findings come from the 2026-10-25 baseline run, summarized under each task.

## Global Constraints

- Production source (`src/`, `bin/`) files stay under 500 lines. `unified-shell.ts` is at 497 and must shrink in Task 1.
- No new runtime dependencies.
- Never show authors raw JSON, block ids, or hex image ids (spec anti-goal).
- One render path: edit-page markup comes from `renderBlockTree` with the `mark` option. No client-side renderer.
- Public pages keep `frame-ancestors 'none'` and their tight CSP. Only the editor page gets `blob:` in `img-src`.
- Commit gate: `lefthook` (biome, tsc, knip:gate, circular, size, c8). Never `--no-verify`.
- Every task runs `npm run typecheck`, `npm run lint`, `npm test`, and the e2e specs it touches before committing.
- Work in `/home/john/src/rkr-blog-exp` on `exp/reusable-blocks`. Rebuild the git-ignored admin bundle with `npm run build:admin` before e2e.
- UI copy is plain sentence case ("Add image", "Page settings"). No glyph-only buttons without a visible or `aria-label` text.

## Review Focus

1. **Edits after a structural change land on the wrong block.** After insert, move or delete, the next text blur must write to the block under the cursor. Pinned by Task 1's e2e `edit after insert writes the right block`.
2. **Save fails or the browser goes offline mid-edit.** The edit must survive a reload and sync on reconnect. Pinned by Task 7's e2e `offline text edit survives reload`.
3. **Two tabs edit the same page.** The second save must not silently overwrite the first. Pinned by Task 7's route test `stale baseVersion returns 409`.
4. **An empty text block or an image that failed to resolve.** It must stay visible and removable in edit mode and render nothing on the public page. Pinned by Task 1's render test `blank text emits an edit placeholder only when marking` and Task 2's e2e `delete an empty text block`.
5. **Phone width.** All editing actions, including inserting a block and saving a figure, must be reachable at 390px without scrolling to the page bottom. Pinned by Task 8's e2e `phone width add block via sheet`.

---

### Task 1: Live re-render replaces reload and placeholders

Fixes baseline bugs 1, 2, 6: `unitByPath` and `data-rkr-path` go stale after an insert, so a blur writes into the wrong block. Placeholders aren't hydrated and their Configure buttons leak into View mode.

**Files:**
- Create: `src/lib/blocks-edit-render.ts` (the render the edit route does today, extracted: macro lib, image/video maps, `mark`)
- Create: `src/admin/unified-hydrate.ts` (marker parsing, `serverOrder`, `hydrate`, moved out of the shell)
- Modify: `src/routes/admin-blocks.ts` (edit route uses the extracted render, new `POST /admin/blocks/render`)
- Modify: `src/lib/blocks-render.ts` (blank text with `mark` set emits marker + `<p class="rkr-unified-blank" data-rkr-blank></p>`)
- Modify: `src/admin/unified-shell.ts`, `src/admin/unified-insert.ts` (drop `reloadPage`, placeholders, duplicate config wiring)
- Test: `test/lib/blocks-render.test.ts`, `test/routes/admin-blocks.test.ts`, `test/admin/unified-shell.test.ts`, `test/e2e/blocks-unified.spec.ts`

**Model:** `opus` — the shell's core state model changes, and the stale-path bug class has to go away.

**Interfaces:**
- Produces: `renderEditBody(siteRoot: string, tree: BlockTree, log: FastifyBaseLogger): Promise<string>` in `src/lib/blocks-edit-render.ts`.
- Produces: `POST /admin/blocks/render` body `{ tree }` → `200 { html }` (guarded like the other admin block routes, 400 on an invalid tree, never writes to disk).
- Produces: `hydrate(tree: BlockTree, body: Element): HydratedUnit[]` and `type HydratedUnit` exported from `src/admin/unified-hydrate.ts`.
- Produces: in the shell, `applyTree(next: BlockTree, opts?: { select?: Path }): Promise<void>`. It renders, swaps `body.innerHTML`, re-hydrates, re-applies the current mode, restores selection, then requests the save. Every structural change (insert, move, delete, duplicate, dialog commit) goes through it. Text blur keeps updating the tree without re-rendering.
- Produces: `UnifiedShellDeps.render(tree: BlockTree): Promise<string>`, wired in `blocks-page-editor-entry.ts` to the new endpoint.

- [ ] **Step 1: Write the failing tests**
  - `blank text emits an edit placeholder only when marking`: `renderBlockTree({version:1, body:[{type:'text', markdown:''}]}, ctx, lib, {mark})` contains `<!--rkr:path=0-->` and `data-rkr-blank`. The same call without `mark` returns `''`.
  - `POST /admin/blocks/render returns marked html and writes nothing`: response `html` contains `<!--rkr:path=0-->`, and `content/blocks/` file count is unchanged.
  - `render rejects an invalid tree`: `{ tree: { body: 'x' } }` → 400.
  - Shell unit test `insert re-renders and reindexes`: with a fake `render` returning fresh marked HTML, insert at index 0, then blur the element marked `1`. The saved tree has the edit at path `[1]` and `[0]` is untouched.
  - e2e `edit after insert writes the right block`: drag Text above the first paragraph, edit the paragraph that was first, Tab out, reload. Both blocks are present, the edit is in the original paragraph, and the welcome text appears once.
  - e2e `insert does not reload`: set `window.__marker = 1` before the drop. It is still set after the insert settles.
- [ ] **Step 2: Run them and confirm they fail.** `npm test -- --test-name-pattern="blank text|render|reindexes"` and `npm run test:e2e -- blocks-unified`.
- [ ] **Step 3: Implement.** Extract the render, add the endpoint, and move hydration into `unified-hydrate.ts`. Then replace `commitInsert`'s placeholder branch and every `reloadPage()` call with `applyTree`. Delete `reloadPage` and the `rkr-edit-mode` sessionStorage flag. Config tools come from one `addTools()` over the hydrated units, so View mode clears all of them.
- [ ] **Step 4: Run the tests and confirm they pass.** Also run the full `npm test`. `wc -l src/admin/unified-shell.ts` must be under 400.
- [ ] **Step 5: Commit** `feat: re-render in place after structural edits`

### Task 2: Select, move, duplicate and delete blocks

Baseline bugs 3 and 5: an empty block can't be removed, and the editor has no move or delete. Hovering the middle third of a leaf resolves to "inside", which is refused, so tall figures are mostly a dead zone.

**Files:**
- Create: `src/admin/unified-block-actions.ts` (selection outline, block toolbar, keyboard)
- Modify: `src/admin/unified-insert.ts` (leaves split at half: before/after. Containers keep thirds. Existing blocks are draggable via the toolbar's drag handle using `moveNode`.)
- Modify: `src/admin/unified-shell.ts`
- Test: `test/admin/unified-block-actions.test.ts`, `test/admin/unified-insert.test.ts`, `test/e2e/blocks-unified.spec.ts`

**Model:** `sonnet` — UI wiring over existing pure tree ops (`removeAtPath`, `moveNode`, `insertAtPath`, `resolveDrop`).

**Interfaces:**
- Consumes: `applyTree` from Task 1.
- Produces: `mountBlockActions(env: { body: Element; getTree(): BlockTree; getSelected(): Path | null; select(path: Path | null): void; applyTree(next: BlockTree, opts?: { select?: Path }): Promise<void>; configure(path: Path): void }): { refresh(): void }`.
- Toolbar on the selected block, top-left above its outline: type label ("Text", "Image", "Row", "Hero"), drag handle, Move up, Move down, Duplicate, Configure (figure/video/button/macro only), Delete. All are buttons with `aria-label`s.
- Keyboard while a block is selected and focus is not inside editable text: `Alt+ArrowUp` / `Alt+ArrowDown` move, `Mod+D` duplicates, `Delete` or `Backspace` deletes, `Escape` clears selection, `Enter` opens Configure, `ArrowUp`/`ArrowDown` select previous/next block. Inside editable text, `Escape` blurs and selects the containing block.

- [ ] **Step 1: Write the failing tests**
  - `move down swaps siblings`: body `[A,B]`, select `[0]`, Move down. `applyTree` receives `[B,A]` with `select: [1]`.
  - `move up at index 0 is disabled`: the button has `disabled`.
  - `duplicate inserts a deep copy after`: `[A]` → `[A, A']`, with `A'` structurally equal and not the same object.
  - `delete selects the next sibling, else previous, else none`.
  - `leaf drop splits at half`: `dropPosition` for a leaf at 40% height → `before`, at 60% → `after`.
  - e2e `delete an empty text block`: drop Text, click away, select the blank block, press Delete, reload. The tree body length is back to the original.
  - e2e `drag an existing figure below the row`: the order persists after reload.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement** `mountBlockActions` and wire it into the shell. Selection draws `outline:2px solid var(--rkr-edit-accent)` (token from Task 3). Hover keeps a 1px dashed outline. Rows and columns in edit mode get a faint dashed boundary and a corner type label so empty containers are visible.
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit** `feat: block toolbar with move, duplicate and delete`

### Task 3: Editor design system and shared dialog

Baseline UI findings 1, 4, 5, 7, 8. Run the `frontend-design:frontend-design` skill first. The editor chrome must sit on top of any site theme without restyling the page body.

**Files:**
- Create: `src/templates/admin-editor-styles.ts` (exports `EDITOR_CSS`: tokens, toolbar, palette, block chrome, dialog, field, button. Replaces `UNIFIED_CSS` in `admin-blocks-edit.ts`)
- Create: `src/admin/editor-dialog.ts` (one `<dialog>`-based modal: title, scrollable body, sticky footer, Escape/scrim cancel, focus trap via `dialog-focus.ts`)
- Create: `src/admin/palette-groups.ts`
- Modify: `src/admin/macro-dialog-tree.ts` (renders inside `editor-dialog`, one labelled field per row, labels from `fieldSchema`, `markdown` fields as `<textarea rows=4>`)
- Modify: `src/admin/blocks-editor.ts` palette, `src/routes/admin-blocks.ts` `/admin/blocks/macros` (returns `fieldSchema`, `group`, `description`, and filters out root macros: `page`)
- Modify: `src/templates/admin-blocks-edit.ts` (toolbar markup)
- Test: `test/admin/editor-dialog.test.ts`, `test/admin/macro-dialog-tree.test.ts`, `test/routes/admin-blocks.test.ts`, `test/templates/admin-blocks-edit.test.ts`

**Model:** `sonnet` — design judgment, guided by the skill and the decisions below.

**Interfaces:**
- Produces: `openEditorDialog(opts: { title: string; body: Node; primaryLabel: string; onPrimary(): boolean | Promise<boolean>; onCancel?(): void; wide?: boolean }): { close(): void; setError(text: string): void; setBusy(busy: boolean): void }`. `onPrimary` returning false keeps the dialog open.
- Produces: CSS tokens on `.rkr-unified-shell`: `--rkr-edit-accent`, `--rkr-edit-surface`, `--rkr-edit-border`, `--rkr-edit-muted`, `--rkr-edit-radius`, `--rkr-edit-shadow`, `--rkr-edit-font` (system UI stack, independent of the site theme font). Both light and dark values come from the site's `--rkr-*` tokens where they exist.
- Produces: `/admin/blocks/macros` entries `{ name, label, group: 'Sections', description, defaults, fieldSchema }`. Primitives carry `group: 'Basics' | 'Layout' | 'Media'` in `PRIMITIVES`.

Decisions:
- Toolbar: a sticky bar at the top of the editor: page title, `View | Edit` segmented control, save-state pill (dot + text: Saved / Editing / Saving / Offline, will sync / Not saved, Retry), `Page settings` button (Task 6), and a `Save` button visible only in Edit mode and enabled only when not clean. `Mod+E` toggles mode and `Mod+S` saves.
- Palette: a heading "Add block", groups Basics (Text, Button), Media (Image, Video), Layout (Section, Row, Column), Sections (macros). Each item is a full-width row with an inline SVG icon, a label, and a one-line description. Click inserts after the selected block, or at the end. Focusable, with `Enter` inserting.
- A blank text block shows the placeholder "Type something…" via `[data-rkr-blank]:empty::before`.
- Carousels pause in edit mode and while a dialog is open. Toggle `data-rkr-editing` on `<html>`, and the carousel script checks it.
- The page `<h1>` is replaced by the toolbar title (the page's `fields.title`, falling back to the slug).

- [ ] **Step 1: Write the failing tests**
  - `dialog keeps open when primary returns false and shows the error`.
  - `dialog Escape calls onCancel once`.
  - `macro dialog labels come from fieldSchema and markdown fields are textareas`: with schema `{ heading: { label: 'Heading', type: 'text' }, text: { label: 'Body', type: 'markdown' } }`, the labels are `Heading` and `Body` and `text` renders a `TEXTAREA`.
  - `macros endpoint omits root macros and returns groups`: `page` absent, `hero.group === 'Sections'`.
  - `edit page toolbar has title, mode switch and save state`: the template output contains the page title and the `role="group"` mode switch, and contains no `<h1>Edit `.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Move the figure and macro dialog CSS into `EDITOR_CSS`. Delete `.rkr-macro-dialog > *`.
- [ ] **Step 4: Run the tests and confirm they pass.** Then take a screenshot of edit mode at 1280 and 390 with the `test/e2e` server and check it against the decisions above.
- [ ] **Step 5: Commit** `feat: editor design system, palette groups and shared dialog`

### Task 4: Macro overrides take effect

Baseline bug 4: `hero` with `heading: "Probe hero heading"` still renders the default in both the editor and the public page.

**Files:**
- Modify: whichever of `src/lib/blocks-render.ts` (case `'macro'`), `src/lib/macro-library.ts`, or `src/admin/macro-dialog-tree.ts` drops the override. Find it with a failing test first.
- Test: `test/lib/blocks-render.test.ts`, `test/e2e/blocks-unified.spec.ts`

**Model:** `sonnet` — a bug hunt with a clear repro.

- [ ] **Step 1: Write the failing tests**
  - `macro instance slots override defaults`: load the repo `macros/hero.json` and render `{type:'macro', macro:'hero', slots:{heading:'Probe hero heading'}}`. Output contains `Probe hero heading` and not `Fresh food, owned by neighbors`.
  - e2e `macro field edit renders`: configure the hero, set Heading, Save. The editor body and `/:slug` both show the new heading.
- [ ] **Step 2: Run them and confirm they fail.** If the unit test passes, the bug is in the dialog's commit keys. Add a dialog-level test asserting the committed slot keys equal the `fieldSchema` keys.
- [ ] **Step 3: Fix the root cause.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit** `fix: macro instance slots override defaults`

### Task 5: Figure and video dialogs without ids

Baseline UI finding 3 and the spec anti-goal: the dialog asks for hex ids, comma-separated alts and pipe-separated captions, and has two Save buttons. There is no upload or picker and no video block.

**Files:**
- Create: `src/admin/media-source.ts` (source picker → ids, reusing `openSourcePicker`, `uploadMany`/`uploadImage`, `pickFromDrive`, `pickFromOneDrive`, `pickFromPhotos`, and the video equivalents in `video-upload.ts` / `video-insert.ts`)
- Create: `src/admin/figure-image-list.ts` (per-image rows)
- Modify: `src/admin/figure-dialog-tree.ts` (built on `openEditorDialog`. Keep `validateFigureFields` as the commit-time check.)
- Modify: `src/admin/image-edit-panel.ts` (replace the `editor: Editor` dependency with `onPreview(id: string, url: string): void`), `src/admin/blocks-page-editor-entry.ts` (delete the mock TipTap editor and the `window.__rkr*` globals)
- Modify: `src/admin/blocks-editor.ts` (`primitive:video` → `{ type: 'video', slots: { ids: '' } }`, group Media)
- Modify: `src/templates/admin-blocks-edit.ts` (source-picker `<dialog>` and hidden file inputs, copied from `src/templates/admin.ts`)
- Test: `test/admin/figure-dialog-tree.test.ts`, `test/admin/figure-image-list.test.ts`, `test/admin/media-source.test.ts`, `test/e2e/blocks-unified.spec.ts`

**Model:** `opus` — it touches the image pipeline and offline uploads, and removes a cross-module hack.

**Interfaces:**
- Consumes: `openEditorDialog` (Task 3), `applyTree` (Task 1).
- Produces: `pickMedia(kind: 'image' | 'video', deps: MediaSourceDeps): Promise<string[]>`. It returns the new sidecar ids, or `[]` on cancel.
- Produces: `figureSlotsFromList(rows: FigureImageRow[], layout: { matrix: string; justify: string }): Slots` and `listFromFigureSlots(slots: Slots): FigureImageRow[]`, where `FigureImageRow = { id: string; alt: string; caption: string }`. They round-trip the existing `ids` / `alts` / `captions` / `matrix` / `justify` slot encoding so stored pages don't change.

Dialog layout (wide):
- Image list: each row shows a 72px thumbnail, Alt text, Caption, Move up, Move down, Edit image, Remove. "Add images" opens the source picker. An empty figure opens the picker straight away when it is first inserted.
- Layout: a segmented control for Single / Grid / Carousel / Justified / Masonry, mapped to `matrix` (`''`, `NxM` with rows/cols inputs, `1x1`, `justified`, `masonry`). Position uses the existing `JUSTIFY_LABELS` select.
- "Edit image" swaps the dialog body to the image editor for that image. It has labelled tool buttons (Rotate left, Rotate right, Flip horizontal, Flip vertical, Crop, Straighten, Undo, Redo, Reset), the preview at most 50vh tall, and the footer reads "Back to figure" and "Apply edits". Apply commits the ops to the sidecar as today, returns to the list, and refreshes that row's thumbnail. The figure dialog has exactly one primary button: "Save figure".
- The video dialog is the same shell with a single-item list (no layout control) and no image editor.

- [ ] **Step 1: Write the failing tests**
  - `list round-trips slot encoding`: slots `{ids:'aaaaaa,bbbbbb', alts:'A,B', captions:'one|two', matrix:'1x1', justify:'center'}` → rows → slots gives equal slots.
  - `remove and reorder rewrite ids, alts and captions together`.
  - `dialog never renders an input containing a hex id`: no `input` value matches `/^[0-9a-f]{6,64}$/`.
  - `pickMedia returns [] on cancel` and `pickMedia local uploads every selected file`, using fake deps.
  - `image edit panel calls onPreview after apply`.
  - e2e `add image to empty figure via local upload`: drop Image, the picker opens, choose Local, `setInputFiles` with two PNGs, Save figure, reload. Two images render and no `ids` text field exists.
  - e2e `rotate refreshes the row thumbnail`: Edit image, Rotate right, Apply edits. The row thumbnail's `src` changes.
  - e2e `add video block`: drop Video, upload `test/fixtures` mp4, save. A `<video>` renders after reload.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Also run the existing image-pipeline e2e specs (`npm run test:e2e -- image`).
- [ ] **Step 5: Commit** `feat: figure and video dialogs with pickers, no ids`

### Task 6: Page settings

Since the cutover, nothing can edit `fields.title`, `status`, `date` or `tags`, so a new page stays a draft forever.

**Files:**
- Create: `src/admin/page-settings.ts` (dialog built on `openEditorDialog`, reusing `tag-input.ts`)
- Modify: `src/routes/admin-blocks.ts` (the save reads `dest` directly instead of scanning every file, and merges `fields` from the request over the stored ones)
- Modify: `src/templates/admin-blocks-new.ts` and its POST (a Title field. The slug is suggested from the title and editable, and the rule `a-z, 0-9 and hyphens` is shown. Taken slugs return the form with an error, not a 404.)
- Test: `test/admin/page-settings.test.ts`, `test/routes/admin-blocks.test.ts`, `test/e2e/blocks-unified.spec.ts`

**Model:** `sonnet`.

**Interfaces:**
- Produces: `openPageSettings(fields: PageFields, onCommit(fields: PageFields): void)`, where `PageFields = { title: string; status: 'draft' | 'published'; date: string; tags: string[]; excerpt?: string }`. The shell stores the result in `tree.fields` and saves.
- Settings: Title (required), Status (Draft / Published), Publish date (`<input type="date">`, defaulting to today on first publish), Tags, Excerpt (optional textarea). Slug is shown read-only with a link to the public URL. Renaming is out of scope.

- [ ] **Step 1: Write the failing tests**
  - `save merges request fields over stored fields`: stored `{title:'A', tags:['x']}`, request `{status:'published'}`. The file has all three keys.
  - `save does not read other pages`: a malformed `content/blocks/other.json` doesn't break saving `hello`.
  - `new page with taken slug re-renders the form with an error` (status 409, body contains `already exists`).
  - `settings commit requires a title`.
  - e2e `publish a new page`: new page "Spring Sale" → slug `spring-sale` → Page settings → Published → Save. Logged out, `/spring-sale` returns 200 and `/` lists it.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit** `feat: page settings and titled new-page form`

### Task 7: Durable offline saves and conflict detection

The spec requires offline edits to queue and sync. Today a failed save is held only in memory, and any save overwrites another tab's.

**Files:**
- Create: `src/admin/unified-draft.ts` (IndexedDB, the same store family as `draft.ts`. One record per slug: `{ tree, baseVersion, savedAt }`)
- Modify: `src/admin/unified-save.ts`, `src/admin/blocks-page-editor-entry.ts`, `src/routes/admin-blocks.ts`, `src/templates/admin-blocks-edit.ts` (embed `data-version`)
- Test: `test/admin/unified-save.test.ts`, `test/routes/admin-blocks.test.ts`, `test/e2e/blocks-unified.spec.ts`

**Model:** `opus` — data safety.

**Interfaces:**
- Version: the file's `mtimeMs` as a string, embedded on `#rkr-blocks-edit-root[data-version]`. The save request is `{ tree, baseVersion }`. The response is `{ slug, inserted, version }`, or `409 { error: 'conflict', version }` when `baseVersion` is present and differs from the current one.
- Pipeline: write the draft record before each request and clear it on success. On load, a draft newer than the embedded version is applied, and the pill shows "Restored unsaved changes". Network failure → state `offline` ("Offline, will sync"), retried on `online`. 409 → state `conflict` with a dialog: "This page changed somewhere else." with the actions "Load latest" (discard local) and "Keep mine" (resave with the new `baseVersion`).
- Structural edits need the render endpoint. While offline they are refused with the pill notice "Reconnect to add or move blocks". Text edits keep working.

- [ ] **Step 1: Write the failing tests**
  - `stale baseVersion returns 409`, `missing baseVersion still saves` (scripted clients like wp-push).
  - `pipeline writes a draft before request and clears it on success`.
  - `pipeline enters offline on fetch TypeError and drains on online`.
  - e2e `offline text edit survives reload`: `context.setOffline(true)`, edit text, blur, reload (served from SW cache, or go online first and reload before syncing). The edit is restored and syncs, and `/:slug` shows it.
  - e2e `conflict dialog on concurrent edit`: two pages edit the same slug. The second save shows the dialog, and Keep mine wins.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit** `feat: durable offline drafts and save conflicts for the block editor`

### Task 8: Admin pages, phone width and keyboard polish

Baseline UI findings 6, 8, 9: `/admin` 404s, `/admin/blocks` is a bare list, and on a phone the palette sits below the page.

**Files:**
- Modify: `src/routes/admin-blocks.ts`, `src/templates/blocks.ts` (`renderBlocksIndex` admin variant)
- Modify: `src/routes/admin.ts` (`GET /admin` → 302 `/admin/blocks`)
- Modify: `src/templates/admin-editor-styles.ts`, `src/admin/unified-shell.ts`
- Test: `test/routes/admin-blocks.test.ts`, `test/e2e/blocks-unified.spec.ts`

**Model:** `sonnet`.

Decisions:
- `/admin/blocks` becomes a table with Title, Status (badge), Updated (relative date), and Edit / View links. It has a "New page" primary button, a title filter input, and the empty state "No pages yet. Create your first page." Data comes from `readAllPosts` (it has status and dates), joined to the block page list.
- Below 720px: the palette becomes a bottom sheet opened by a floating "Add block" button. It inserts after the selected block, or at the end, then closes. The block toolbar keeps to the viewport. Dialogs go full-screen with the sticky footer.
- A "Phone preview" toggle in the toolbar narrows the page body to 390px in place, without an iframe.
- The build hash in the header is muted and small (`font-size:.75rem; color:var(--rkr-muted)`).

- [ ] **Step 1: Write the failing tests**
  - `GET /admin redirects to /admin/blocks`.
  - `blocks index shows status and an empty state`.
  - e2e `phone width add block via sheet`: viewport 390×844, Edit, tap Add block, tap Text. The new blank block is visible in the viewport and the sheet is closed.
  - e2e `keyboard insert`: Tab to the palette, focus Text, press Enter. The block is inserted and selected.
  - e2e `phone preview narrows body`: the body's `clientWidth` is ≤ 390.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Commit** `feat: admin pages list, phone-width editing, keyboard insert`

### Task 9: Retire the tree-view UI and the legacy TipTap bundle

The old unified-editor Task 7, extended. `/admin/view/:slug` still loads `main.js` (TipTap). The unified View mode replaces it.

**Files:**
- Modify: `src/routes/admin-shell.ts` (`/admin/view/:slug` → 302 `/admin/blocks/edit/:slug`), `package.json` `build:admin` and `knip` entries, `scripts/gen-precache.ts` inputs, and the SW precache list
- Delete: `src/admin/main.ts` and every module only it reaches (let `knip` list them after removing the entry), the tree card UI in `src/admin/blocks-page-editor.ts` (keep the pure tree ops), `src/admin/preview-page.ts`, `renderAdminPage` in `src/templates/admin.ts` if nothing else uses it, and their tests
- Keep: `apps/image-pwa`, `packages/image-edit`, the OPFS worker, `outbox.ts`/`sync.ts`, if anything still reaches them. Prove each deletion with knip.
- Test: full `npm test`, full `npm run test:e2e`, `npm run knip:gate`, `npm run size`

**Model:** `opus` — wide deletion across the bundle, the SW precache and the e2e suite.

- [ ] **Step 1: Write the failing test** `GET /admin/view/:slug redirects to the block editor`, and a guard test asserting `src/admin/main.ts` doesn't exist and `build:admin` doesn't name it.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Remove the entry, delete what knip reports as unused, and update or delete the e2e specs that drove the TipTap editor.** Keep the coverage those specs gave the image pipeline by re-pointing them at the figure dialog.
- [ ] **Step 4: Run the full unit suite, the full e2e suite, knip, size and circular. All must be green.**
- [ ] **Step 5: Commit** `feat: retire the TipTap editor bundle and tree-view UI`

### Task 10: Full-flow e2e, docs, and folding the working docs

**Files:**
- Modify: `test/e2e/blocks-unified.spec.ts` (`unified flow: type, dialog, drop, save, reload`)
- Modify: `docs/spec.md`, `docs/implementation.md`, `docs/RUNBOOK.md`, `docs/developer-quickstart.md`, `docs/TESTING.md`, `docs/DEFERRED.md`, `docs/backlog.md` (close the editor items that shipped, including group 4's three editor/figure items if the new dialog resolves them)
- Delete: `docs/superpowers/plans/2026-10-22-*.md`, `2026-10-23-json-cutover.md`, `2026-10-24-unified-editor.md`, this plan, and `docs/superpowers/specs/2026-10-2*-*.md`, after folding their decisions into `spec.md` (behavior) and `implementation.md` (design)

**Model:** `sonnet`.

- [ ] **Step 1: Write the full-flow e2e.** It covers a new titled page, typing, an image upload, a caption edit, a palette drop, a hero override, publishing, the reload check, and the logged-out public check.
- [ ] **Step 2: Run it and confirm it passes.** If it fails, fix the cause in the owning module and say which task's code it was.
- [ ] **Step 3: Update the docs.** Remove every reference to `/admin/editor`, TipTap, the tree view, and the preview iframe.
- [ ] **Step 4: Run** `grep -rn "admin/editor\|TipTap\|tiptap" docs src`. Expected: only the retired-editor 404 copy and history-free mentions.
- [ ] **Step 5: Commit** `docs: fold the blocks editor specs into spec and implementation`

### Task 11: Whole-branch review

**Model:** `opus`.

- [ ] **Step 1:** Run `/review-step` over `main...exp/reusable-blocks` as a whole, checking it against `docs/spec.md` and the anti-goals above (no ids, no raw JSON, one render path).
- [ ] **Step 2:** Fix the Must-fix items in follow-up commits. Should-fix items go to `docs/DEFERRED.md` unless they are one-line fixes.
- [ ] **Step 3:** Run the full gate one more time: typecheck, lint, knip:gate, circular, `npm test`, `npm run test:e2e`.

### Task 12: Merge and deploy (stop for approval first)

This changes production content: the cutover runs `blocks-migrate --all` and `--archive` against the live site roots, and the legacy editor goes away. The controller stops before this task and asks the user.

- [ ] **Step 1:** Report the gate results, the review outcome, and the exact production steps (backup of each site's `content/`, migrate, archive, deploy with `deploy.sh update .`, verify) and wait for approval.
- [ ] **Step 2:** On approval, use `superpowers:finishing-a-development-branch` to land the branch on `main`, then deploy per the project's deploy memory and run `verify-deploy.sh`.
