# Reusable Blocks (JSON pages) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace page markdown with JSON macro trees (markdown only inside text widgets) behind an experimental branch, with palette editing and phone preview.

**Architecture:** New pure libs for block schema plus defaults-merge plus cycle guard; a renderer that walks the tree to div/flex HTML and delegates leaves to existing figure/video widgets; a macro library with root-page defaults replacing site.json chrome; a one-way markdown-to-JSON migrator; an editor palette with inline fields enforcing depth-3; a preview toggle and theme CSS additions.

**Tech Stack:** TypeScript (Node >=22), existing remark pipeline for text-widget markdown only, TipTap reuse inside text fields, existing WidgetRegistry for leaves, node:test with --conditions=development.

**Spec:** `docs/superpowers/specs/2026-10-22-reusable-blocks-design.md`

## Global Constraints

- Node >=22.0.0; no new runtime dependencies without explicit approval.
- Experimental work happens on branch `exp/reusable-blocks` in worktree `/home/john/src/rkr-blog-exp`; `main` stays deployable.
- Pages are pretty-printed JSON with sorted keys; git diffs stay readable.
- Each stored macro definition max 3 container levels; enforced in the editor, never as a build failure.
- No `justify=inline` figures going forward; migrator maps inline to small centered figures.
- Macro cycles render an HTML comment, never loop.
- Layout is divs plus flexbox/grid; split/columns stack under ~720px with no per-page positioning.
- Every task: `npm run typecheck && npm run lint && npm run knip:gate && npm test <touched-file-tests>` green before commit.

## Review Focus

- Self-referencing macro (`hero` includes `hero`) renders a comment instead of hanging the build.
- Editor refuses a 4th container level inside one macro and offers save-inner-as-macro.
- Empty-string override stays local and does not fall back to the macro default, while an absent slot does.
- Migrated page with an old `justify=inline` figure renders centered, not broken.
- Unknown macro name in page JSON renders a comment naming the macro, not a 500.

---

### Task 1: Block schema plus defaults merge plus cycle guard

**Files:**
- Create: `src/lib/blocks.ts`
- Test: `test/lib/blocks.test.ts`

**Model:** `sonnet` — pure logic but recursive merge plus cycle semantics need judgment.

**Interfaces:**
- Consumes: nothing new (uses `PostFrontmatter`-style plain types only).
- Produces: `parseBlockTree(json: unknown) -> BlockTree`, `resolveSlots(macroDef: MacroDef, overrides: Slots) -> BlockNode`, `detectCycle(lib: MacroLib, name: string) -> string[] | null`, `containerDepth(node: BlockNode) -> number` for editor + tests in Tasks 2–5.

- [ ] **Step 1: Write the failing test**

```ts
// test/lib/blocks.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { containerDepth, detectCycle, resolveSlots } from "../../src/lib/blocks.ts";
describe("blocks", () => {
  it("unset follows default, empty string stays local", () => {
    const out = resolveSlots({ defaults: { title: "Brand" } }, {});
    assert.equal(out.slots.title, "Brand");
  });
  it("detects self cycle", () => {
    assert.ok(detectCycle({ hero: ["hero"] }, "hero"));
  });
  it("measures section>row>col>leaf as depth 3", () => {
    assert.equal(containerDepth({ type: "section", children: [{ type: "row", children: [{ type: "col", children: [{ type: "text" }] }] }] }), 3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/lib/blocks.test.ts`
Expected: FAIL with "Cannot find module …/src/lib/blocks.ts"

- [ ] **Step 3: Implement `parseBlockTree`, `resolveSlots`, `detectCycle`, `containerDepth` in `src/lib/blocks.ts`**

Discriminated union `BlockNode = section | row | col | flow | text | figure | video | button | list | marquee | accordion | progress | embed | macro-instance`; `resolveSlots` deep-merges overrides over defaults with absent-follows-default and empty-string-stays-local; `detectCycle` follows macro references transitively.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/lib/blocks.test.ts`
Expected: PASS

- [ ] **Step 5: Run gates plus commit**

Run: `npm run typecheck && npm run lint && npm run knip:gate && npm test -- test/lib/blocks.test.ts`
Expected: PASS, then:

```bash
git add src/lib/blocks.ts test/lib/blocks.test.ts
git commit -m "feat: add block schema with defaults merge and cycle guard"
```

### Task 2: Tree renderer to div/flex HTML

**Files:**
- Create: `src/lib/blocks-render.ts`
- Modify: `src/lib/content.ts:106-118` (add tree entry point alongside `renderPostHtml`, no behavior change to markdown path)
- Test: `test/lib/blocks-render.test.ts`

**Model:** `sonnet` — multi-widget coordination reusing existing leaf renderers.

**Interfaces:**
- Consumes: `BlockTree`, `resolveSlots`, `detectCycle` from Task 1; existing `ImageMap`, `VideoMapView`, `WidgetRegistry`.
- Produces: `renderBlockTree(tree: BlockTree, ctx: RenderCtx, lib: MacroLib) -> Promise<string>` used by Tasks 5–6.

- [ ] **Step 1: Write the failing test**

```ts
// test/lib/blocks-render.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
it("renders section>row>text to nested divs", async () => {
  const html = await renderBlockTree(sectionWithHello, fakeCtx, emptyLib);
  assert.match(html, /rkr-section.*rkr-row.*Hello/s);
});
it("renders text markdown bold", async () => {
  const html = await renderBlockTree(textBold, fakeCtx, emptyLib);
  assert.match(html, /<strong>b<\/strong>/);
});
it("renders unknown macro as comment, not 500", async () => {
  const html = await renderBlockTree(unknownMacroRef, fakeCtx, emptyLib);
  assert.match(html, /<!-- unknown macro: nope -->/);
});
it("renders macro cycle as comment", async () => {
  const html = await renderBlockTree(selfRefHero, fakeCtx, cyclicLib);
  assert.match(html, /<!-- macro cycle: hero -->/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/lib/blocks-render.test.ts`
Expected: FAIL with "Cannot find module …/src/lib/blocks-render.ts"

- [ ] **Step 3: Implement `renderBlockTree(tree, ctx, lib)` in `src/lib/blocks-render.ts`**

Recurse containers to `<div class="rkr-section|rkr-row|rkr-col …">`; `flow.blocks` in order; `text.markdown` through the existing remark pipeline only (no directive parsing inside); `figure`/`video` delegate to existing widget renderers; unknown macro names and cycles emit `<!-- … -->` comments.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/lib/blocks-render.test.ts`
Expected: PASS

- [ ] **Step 5: Run gates plus commit**

Run: `npm run typecheck && npm run lint && npm run knip:gate && npm test -- test/lib/blocks-render.test.ts`
Expected: PASS, then:

```bash
git add src/lib/blocks-render.ts src/lib/content.ts test/lib/blocks-render.test.ts
git commit -m "feat: render JSON block trees to div/flex HTML"
```

### Task 3: Macro library plus root page defaults

**Files:**
- Create: `src/lib/macro-library.ts`
- Test: `test/lib/macro-library.test.ts`

**Model:** `sonnet` — settings-precedence judgment (root default vs macro default).

**Interfaces:**
- Consumes: `resolveSlots`, `detectCycle` from Task 1.
- Produces: `loadMacroLibrary(dir: string) -> MacroLib`, `getRootDefaults(lib) -> Slots`, `expandMacro(lib, name, overrides) -> BlockNode` for Tasks 2, 4, 5.

- [ ] **Step 1: Write the failing test**

```ts
// test/lib/macro-library.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
it("curried macro fixes some slots, leaves rest open", () => {
  const node = expandMacro(libWithBaseCards, "cards-home", { title: "News" });
  assert.equal(node.slots.title, "News");
});
it("root page supplies chrome defaults", () => {
  assert.ok(getRootDefaults(libWithPage).menu);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/lib/macro-library.test.ts`
Expected: FAIL with "Cannot find module …/src/lib/macro-library.ts"

- [ ] **Step 3: Implement `loadMacroLibrary`, `expandMacro`, `getRootDefaults` in `src/lib/macro-library.ts`**

Load `macros/*.json` (pretty-printed, sorted keys); macro file = `{ defaults, fieldSchema, tree }`; currying = a macro whose tree is `{ macro: base, slots: fixed }`; root `page` macro holds chrome slots (menu, announcement, footer, fundraising goal/raised) replacing `config/site.json` reads on the experimental path only.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/lib/macro-library.test.ts`
Expected: PASS

- [ ] **Step 5: Run gates plus commit**

Run: `npm run typecheck && npm run lint && npm run knip:gate && npm test -- test/lib/macro-library.test.ts`
Expected: PASS, then:

```bash
git add src/lib/macro-library.ts test/lib/macro-library.test.ts
git commit -m "feat: add macro library with root page defaults"
```

### Task 4: One-way markdown-to-JSON migration

**Files:**
- Create: `src/lib/markdown-migrate.ts`
- Test: `test/lib/markdown-migrate.test.ts`

**Model:** `sonnet` — mdast edge cases need judgment.

**Interfaces:**
- Consumes: `parsePost` from `src/lib/content.ts`, `BlockTree` from Task 1.
- Produces: `migratePostToTree(rawMarkdown: string) -> BlockTree` used once for fixtures and the co-op import; no live dual-write.

- [ ] **Step 1: Write the failing test**

```ts
// test/lib/markdown-migrate.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
it("maps frontmatter to page fields and body to flow array", () => {
  const tree = migratePostToTree("---\ntitle: T\nslug: t\n---\n\nHello\n\n::figure{ids=\"ab12cd\"}\n");
  assert.equal(tree.body[0].type, "flow");
});
it("maps justify=inline to centered figure", () => {
  const tree = migratePostToTree("---\ntitle: T\nslug: t\n---\n\n::figure{ids=\"ab12cd\" justify=\"inline\"}\n");
  assert.equal(tree.body[0].children[0].slots.justify, "center");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/lib/markdown-migrate.test.ts`
Expected: FAIL with "Cannot find module …/src/lib/markdown-migrate.ts"

- [ ] **Step 3: Implement `migratePostToTree` in `src/lib/markdown-migrate.ts`**

Frontmatter title/slug/date/status/tags become page fields; mdast children become `flow.blocks` in order (paragraph/heading/list/code → `text.markdown` round-tripped to source, directives → matching widget slots); `justify=inline` maps to `center`; unknown directives become comments, never throws.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/lib/markdown-migrate.test.ts`
Expected: PASS

- [ ] **Step 5: Run gates plus commit**

Run: `npm run typecheck && npm run lint && npm run knip:gate && npm test -- test/lib/markdown-migrate.test.ts`
Expected: PASS, then:

```bash
git add src/lib/markdown-migrate.ts test/lib/markdown-migrate.test.ts
git commit -m "feat: migrate markdown posts to JSON block trees"
```

### Task 5: Editor palette plus inline fields plus depth-3 guide

**Files:**
- Create: `src/admin/blocks-editor.ts`
- Modify: `src/templates/admin.ts` (mount point, exact lines located at implementation time)
- Test: `test/admin/blocks-editor.test.ts`

**Model:** `sonnet` — multi-file UI coordination with TipTap reuse.

**Interfaces:**
- Consumes: `containerDepth` from Task 1, `MacroLib` field schemas from Task 3.
- Produces: palette insert + inline-field editing + duplicate + save-as-macro + depth indicator consumed by Task 6 preview.

- [ ] **Step 1: Write the failing test**

```ts
// test/admin/blocks-editor.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { insertAllowed, depthOfInsertion } from "../../src/admin/blocks-editor.ts";
describe("blocks editor", () => {
  it("blocks a 4th container level inside one macro", () => {
    assert.equal(insertAllowed(depth3Macro, "row"), false);
  });
  it("duplicate copies overrides only", () => {
    assert.deepEqual(duplicateOverrides({ title: "X" }), { title: "X" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/admin/blocks-editor.test.ts`
Expected: FAIL with "Cannot find module …/src/admin/blocks-editor.ts"

- [ ] **Step 3: Implement palette plus cards plus `insertAllowed`, `duplicateOverrides` in `src/admin/blocks-editor.ts`**

Palette lists macros from `MacroLib` field schemas; insert adds a collapsed card; card expands to inline fields (rich text only for `text.markdown` via existing TipTap, image picker via existing upload, link picker for page/listing/URL); depth meter shows current depth; a 4th-level drop is refused with a "save inner part as its own macro" prompt; no JSON or fence editing in normal flow.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/admin/blocks-editor.test.ts`
Expected: PASS

- [ ] **Step 5: Run gates plus commit**

Run: `npm run typecheck && npm run lint && npm run knip:gate && npm test -- test/admin/blocks-editor.test.ts`
Expected: PASS, then:

```bash
git add src/admin/blocks-editor.ts src/templates/admin.ts test/admin/blocks-editor.test.ts
git commit -m "feat: add palette editor with inline fields and depth guide"
```

### Task 6: Desktop/phone preview toggle

**Files:**
- Modify: `src/templates/admin.ts` (preview iframe widths, exact lines at implementation time)
- Test: `test/templates/blocks-preview.test.ts`

**Model:** `haiku` — mechanical: two widths rendering the same tree.

**Interfaces:**
- Consumes: `renderBlockTree` from Task 2, editor tree state from Task 5.
- Produces: preview toggle used for manual verification; no new APIs.

- [ ] **Step 1: Write the failing test**

```ts
// test/templates/blocks-preview.test.ts
import assert from "node:assert/strict";
import { it } from "node:test";
it("preview renders the same tree at both widths", async () => {
  const [a, b] = await renderPreviewAtWidths(tree, [1200, 390]);
  assert.ok(a.includes("Hello") && b.includes("Hello"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/templates/blocks-preview.test.ts`
Expected: FAIL with function not defined.

- [ ] **Step 3: Implement preview widths in `src/templates/admin.ts`**

Same-tree render at ~1200px and ~390px iframes or container widths; reuse `/admin/view/:slug` path; listings keep the decided offline placeholder.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/templates/blocks-preview.test.ts`
Expected: PASS

- [ ] **Step 5: Run gates plus commit**

Run: `npm run typecheck && npm run lint && npm run knip:gate && npm test -- test/templates/blocks-preview.test.ts`
Expected: PASS, then:

```bash
git add src/templates/admin.ts test/templates/blocks-preview.test.ts
git commit -m "feat: add desktop/phone preview toggle for blocks"
```

### Task 7: Theme CSS for section/row/col plus fixtures

**Files:**
- Modify: `static/themes/default.css` (append `rkr-section`/`rkr-row`/`rkr-col` flex rules, exact location at implementation time)
- Create: `test/templates/blocks.test.ts` plus `test/fixtures/blocks/{hero,cards-3,logo-wall}.json`

**Model:** `haiku` — mechanical CSS plus fixture transcription.

**Interfaces:**
- Consumes: class names emitted by Task 2.
- Produces: five inventory patterns rendering on desktop plus 390px with no horizontal scroll.

- [ ] **Step 1: Write the failing test**

```ts
// test/templates/blocks.test.ts
import assert from "node:assert/strict";
import { it } from "node:test";
it("cards-3 fixture renders three cards", async () => {
  const html = await renderFixture("cards-3");
  assert.equal((html.match(/rkr-card/g) ?? []).length, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/templates/blocks.test.ts`
Expected: FAIL with fixture or class missing.

- [ ] **Step 3: Implement CSS plus fixtures**

`.rkr-section`, `.rkr-section-inner`, `.rkr-row` (flex row, wrap), `.rkr-col` (flex column), wave divider `aria-hidden`, hero scrim for contrast, `prefers-reduced-motion` for marquee; fixtures for hero, split, 3-cards, logo wall, newsletter band.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/templates/blocks.test.ts`
Expected: PASS

- [ ] **Step 5: Run gates plus commit**

Run: `npm run typecheck && npm run lint && npm run knip:gate && npm test -- test/templates/blocks.test.ts`
Expected: PASS, then:

```bash
git add static/themes/default.css test/templates/blocks.test.ts test/fixtures/blocks/
git commit -m "feat: add block flex CSS and macro fixtures"
```
