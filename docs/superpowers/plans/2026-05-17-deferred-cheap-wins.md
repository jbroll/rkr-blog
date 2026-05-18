# Deferred cheap-wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close five DEFERRED.md items that turned out to be small, no-tradeoff changes mis-estimated as larger work. (Task 4 — comment bubble — shipped 2026-05-16 via the post-comment-bubble plan.)

**Architecture:** Five independent tasks, each self-contained and individually shippable; order is cheapest-first. No shared state between them. Each is committed on its own (the active `.git/hooks/pre-commit` shim runs the full gauntlet per commit).

**Tech Stack:** TypeScript (ES modules, `--experimental-strip-types`), Fastify, remark/mdast, `node:test`, headless-Chromium visual checks for presentational changes (the repo's established pattern).

Source analysis: the bucket-B subset of the 2026-05-17 DEFERRED.md relevance review. Reclassified back to "real work" (NOT in this plan): SW-stale-comments, post-deploy-30s SW half, slug-rename — each carries a genuine tradeoff/design, see the bucket-C review.

---

### Task 1: Teaser + `_site-banner` reads → async

**Files:**
- Modify: `src/routes/public.ts` (the two `fs.readFileSync` reads in the `/` handler — `_site-banner.md` ~line 156, top-post teaser ~line 195)
- Test: `test/routes/public.test.ts` (existing GET `/` coverage already exercises both paths; no new test — this is a behaviour-preserving I/O swap verified by the existing suite)

- [ ] **Step 1: Confirm the two call sites**

Run: `grep -n "fs.readFileSync" src/routes/public.ts`
Expected: exactly two hits inside `publicRoutes` — the `_site-banner.md` read and the teaser top-post read (`path.join(siteRoot, top.path)`).

- [ ] **Step 2: Convert both to async**

Both reads are already inside `async` route handlers. Change each:

```ts
// _site-banner.md read:
const raw = await fs.promises.readFile(siteBannerPath, 'utf8');
// teaser top-post read:
const rawTop = await fs.promises.readFile(path.join(siteRoot, top.path), 'utf8');
```

Keep the surrounding `try { … } catch { … }` blocks exactly as-is (malformed/missing file still falls through). No other lines change.

- [ ] **Step 3: Typecheck + run the public route suite**

Run: `npm run typecheck && node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/routes/public.test.ts test/routes/public-tag-filter.test.ts`
Expected: typecheck clean; all tests pass (banner + teaser render paths are covered there).

- [ ] **Step 4: Commit**

```bash
git add src/routes/public.ts
git commit -m "perf(public): async _site-banner + teaser reads (no sync fs on GET /)"
```

- [ ] **Step 5: Remove the DEFERRED entry**

Delete the `**Teaser top-post sync \`fs.readFileSync\`**` bullet from `docs/DEFERRED.md` (Performance / reliability section). Commit:

```bash
git add docs/DEFERRED.md
git commit -m "docs(deferred): drop teaser sync-read (shipped)"
```

---

### Task 2: Friendlier "Position" select labels

**Files:**
- Modify: `src/templates/admin.ts` (the `<select id="rkr-figure-justify">` block, ~line 103; Layout radios at 83-85 are already friendly — "Grid/Justified/Masonry" — leave them)
- Test: `test/templates/admin.test.ts` if it exists, else `test/admin/*` — assert the select keeps machine `value=`s and gains friendly visible text

- [ ] **Step 1: Read the current select**

Run: `sed -n '100,125p' src/templates/admin.ts`
Expected: `<select id="rkr-figure-justify">` with `<option value="…">` entries (machine values like `center`, `bleed`, `inline`, plus float variants).

- [ ] **Step 2: Write the failing test**

In the admin template test file (create `test/templates/admin.test.ts` if none — mirror `test/templates/search.test.ts` structure), import the template render fn and assert label/value split:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderAdminPage } from '../../src/templates/admin.ts'; // match the real export

test('figure Position select keeps machine values but shows friendly labels', () => {
  const html = renderAdminPage(/* minimal args the fn needs */);
  // value attributes unchanged (no markdown/schema migration):
  assert.match(html, /<option value="center"[^>]*>Centered</);
  assert.match(html, /<option value="bleed"[^>]*>Edge-to-edge</);
  assert.match(html, /<option value="inline"[^>]*>Inline</);
});
```

If `admin.ts` has no pure render export (it may be a static string constant), assert against that exported constant instead. Match the real symbol — `grep -n "export" src/templates/admin.ts`.

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/templates/admin.test.ts`
Expected: FAIL (labels are currently the machine strings).

- [ ] **Step 4: Relabel the options (values unchanged)**

Edit only the visible text of each `<option>` in the `rkr-figure-justify` select, keeping every `value=` byte-identical. Friendly text: `center`→Centered, `bleed`→Edge-to-edge, `inline`→Inline, float-left→Float left, float-right→Float right (use the exact value set present in the file). No JS change — `select.value` round-trips the same machine strings into the directive.

- [ ] **Step 5: Run test to verify it passes + typecheck**

Run: `npm run typecheck && node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/templates/admin.test.ts`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit + drop DEFERRED entry**

```bash
git add src/templates/admin.ts test/templates/admin.test.ts docs/DEFERRED.md
# (edit DEFERRED.md: the "Friendlier layout/position values" bullet — the
#  values stay machine strings, only labels changed; the entry's premise
#  "needs a value migration" is resolved. Delete the bullet.)
git commit -m "feat(editor): friendly Position labels (machine values unchanged)"
```

---

### Task 3: Advanced disclosure for width/aspect/fit/autoplay

**Files:**
- Modify: `src/templates/admin.ts` (wrap the width/aspect/fit/autoplay fields, which start ~line 111, in a `<details class="rkr-attr-advanced">`)
- Modify: `static/admin/main.css` or the admin styles module (minor: default-collapsed styling if needed — `<details>` is collapsed by default natively, so likely zero CSS)
- Test: template assertion that the four fields are inside a `<details>` and still present (ids unchanged so the figure-attrs JS still finds them)

- [ ] **Step 1: Read the field block**

Run: `sed -n '108,135p' src/templates/admin.ts`
Expected: the four labelled inputs `rkr-figure-width`, `rkr-figure-aspect`, `rkr-figure-fit`, `rkr-figure-autoplay` (confirm exact ids).

- [ ] **Step 2: Write the failing test**

```ts
test('width/aspect/fit/autoplay live inside an Advanced <details>', () => {
  const html = renderAdminPage(/* … */);
  const det = html.slice(html.indexOf('rkr-attr-advanced'), html.indexOf('</details>'));
  for (const id of ['rkr-figure-width', 'rkr-figure-aspect', 'rkr-figure-fit', 'rkr-figure-autoplay']) {
    assert.ok(det.includes(id), `${id} should be inside the Advanced disclosure`);
  }
});
```

- [ ] **Step 3: Run test → fails**

Run: `node --test … test/templates/admin.test.ts`
Expected: FAIL (no `<details>` yet).

- [ ] **Step 4: Wrap the four fields**

Surround exactly those four label+input pairs with:

```html
<details class="rkr-attr-advanced">
  <summary>Advanced</summary>
  <!-- existing width/aspect/fit/autoplay label+input pairs, unmodified -->
</details>
```

Do not change any `id`, `name`, or input markup — only add the wrapper. The figure-attrs JS queries by id and keeps working (elements remain in the DOM, just collapsed).

- [ ] **Step 5: Run test → passes; visual check**

Run: `npm run typecheck && node --test … test/templates/admin.test.ts`
Then a headless-Chromium screenshot of `/admin` editor (repo's established harness pattern) confirming the panel is less busy and the disclosure expands. Expected: PASS; advanced fields collapsed by default, expandable.

- [ ] **Step 6: Commit + drop DEFERRED entry**

```bash
git add src/templates/admin.ts test/templates/admin.test.ts docs/DEFERRED.md
git commit -m "feat(editor): collapse advanced figure fields behind <details>"
```

---

### Task 5: Escaped comma in per-image `alts`

**Files:**
- Modify: `src/lib/prose-markdown.ts` (the `alts` split at line 219 `altsRaw.split(',')` and the serialize at line 224 `quote(altsList.join(','))`)
- Modify: the render-side alts consumer if it independently splits on `,` — `grep -rn "alts" src/lib/widget-helpers.ts src/widgets/figure.ts` first
- Test: `test/lib/prose-markdown.test.ts` (round-trip an alt containing a literal comma)

- [ ] **Step 1: Map every place `alts` is split/joined on comma**

Run: `grep -rn "alts" src/lib/prose-markdown.ts src/lib/widget-helpers.ts src/widgets/figure.ts`
Expected: the parse split (prose-markdown.ts:219), the serialize join (224), and any render-side split. List them — all must use the same escape convention.

- [ ] **Step 2: Write the failing round-trip test**

```ts
test('a per-image alt may contain an escaped comma', () => {
  // alt text: 'A cat, sitting'  →  serialized as  A cat\, sitting
  const serialized = serializeAlts(['A cat, sitting', 'Plain']);   // real fn name from the file
  assert.match(serialized, /A cat\\, sitting,Plain/);
  const parsed = parseAlts(serialized);
  assert.deepEqual(parsed, ['A cat, sitting', 'Plain']);
});
```

Use the actual exported helpers; if splitting/joining is inline (not factored), Step 4 extracts `splitAlts`/`joinAlts` pure helpers and the test targets those.

- [ ] **Step 3: Run → fails**

Run: `node --test … test/lib/prose-markdown.test.ts`
Expected: FAIL (current code splits on every comma).

- [ ] **Step 4: Implement escape-aware split/join**

Add two pure helpers in `prose-markdown.ts` and use them at both sites (and any render-side site found in Step 1):

```ts
// Split on unescaped commas; \, is a literal comma in a single alt.
export function splitAlts(s: string): string[] {
  return s.split(/(?<!\\),/).map((a) => a.replace(/\\,/g, ',').trim());
}
export function joinAlts(alts: string[]): string {
  return alts.map((a) => a.replace(/,/g, '\\,')).join(',');
}
```

Replace `altsRaw.split(',').map(s => s.trim())` with `splitAlts(altsRaw)` and `altsList.join(',')` with `joinAlts(altsList)`. Apply the same to the render-side splitter so display matches storage.

- [ ] **Step 5: Run → passes; full lib suite**

Run: `npm run typecheck && node --test … test/lib/prose-markdown.test.ts`
Expected: PASS, no regressions in existing alts tests.

- [ ] **Step 6: Commit + narrow the DEFERRED entry**

The container-directive form is still the long-term answer for per-image *captions*; the comma blocker is gone. Reword the `**Container directive form for galleries**` bullet to drop the comma rationale (keep it, triggered only by "per-image captions inside a multi-image directive").

```bash
git add src/lib/prose-markdown.ts test/lib/prose-markdown.test.ts docs/DEFERRED.md
git commit -m "feat(figures): support \\, escaped commas in per-image alts"
```

---

### Task 6: "Save & view" combined editor button

**Decision (YAGNI, stated for review):** add a *second* toolbar action "Save & view" that runs the existing save then navigates to the resulting permalink. The existing "Save" (stay in editor) and the post-save "view →" status link are unchanged. No confirm-on-dirty complexity — it always saves first, then navigates; if the save fails, it does not navigate (the existing error path shows in the status line).

**Files:**
- Modify: `src/admin/save.ts` (it already computes `result.slug` and calls `setStatusWithLink('saved /…','/…','view →')` at line 128 — add an opt-in "navigate after save" path)
- Modify: the toolbar template/markup that defines the Save button (`grep -rn "data-cmd=\"save\"" src/templates src/admin`) — add a sibling `data-cmd="save-view"` button
- Modify: the toolbar command dispatch that maps `data-cmd` → handler (`grep -rn "data-cmd" src/admin/*.ts`)
- Test: `test/admin/*` — unit-test the save module's "navigate after save" branch with a stubbed `location`

- [ ] **Step 1: Locate the save command wiring**

Run: `grep -rn "data-cmd=\"save\"|data-cmd|setStatusWithLink|save-view" src/admin src/templates`
Expected: the toolbar button markup, the dispatch switch, and `save.ts`'s save entry point. Note exact symbol names.

- [ ] **Step 2: Write the failing test**

```ts
test('saveAndView navigates to the new permalink after a successful save', async () => {
  const nav: string[] = [];
  // inject a fake navigate fn (don't touch real location)
  await runSave({ thenNavigate: true, navigate: (u: string) => nav.push(u), /* …stubs… */ });
  assert.deepEqual(nav, ['/the-saved-slug']);
});
test('saveAndView does NOT navigate when the save fails', async () => {
  const nav: string[] = [];
  await runSave({ thenNavigate: true, navigate: (u) => nav.push(u), forceFail: true });
  assert.deepEqual(nav, []);
});
```

Match the real save entry point's signature; thread an optional `thenNavigate`/`navigate` param rather than calling `location.assign` directly so it's unit-testable.

- [ ] **Step 3: Run → fails**

Run: `node --test … test/admin/save.test.ts`
Expected: FAIL (no `thenNavigate` path).

- [ ] **Step 4: Implement**

In `save.ts`, after the existing success branch that computes `result.slug`, when the caller passed `thenNavigate`, call the injected `navigate('/' + result.slug)` (default `navigate = (u) => location.assign(u)`), guarded so it only runs on save success. Add the toolbar button (`<button data-cmd="save-view">Save &amp; view</button>` next to Save) and a dispatch case mapping `save-view` → save entry with `thenNavigate: true`.

- [ ] **Step 5: Run → passes; e2e smoke**

Run: `npm run typecheck && node --test … test/admin/save.test.ts`
Then, if the editor e2e harness is quick, add/extend an `editor-flow.spec.ts` case: edit → click "Save & view" → asserts URL is the permalink. (If e2e setup is heavy, the unit test + a manual headless check suffices — match the repo's existing editor-flow coverage depth.)

- [ ] **Step 6: Commit + drop DEFERRED entry**

```bash
git add src/admin/save.ts src/templates/* test/admin/save.test.ts docs/DEFERRED.md
git commit -m "feat(editor): Save & view button (save, then go to permalink)"
```

---

## Self-Review

**Spec coverage (bucket-B subset):** Task 1 = teaser sync read; Task 2 = friendlier values (the cheap presentation-only half — the entry's "value migration" premise is dispelled, machine values stay); Task 3 = advanced disclosure; Task 4 = comment-bubble float (shipped 2026-05-16, removed from this plan); Task 5 = container-alt comma (the comma blocker specifically; captions remain a separate, still-deferred concern); Task 6 = Save & view. The other three bucket-B candidates (SW-stale-comments, post-deploy-30s SW half, slug-rename) are deliberately excluded with a stated reason and routed to the bucket-C review — not silently dropped.

**Placeholder scan:** Each code-changing step shows the actual edit. A few steps say "match the real exported symbol / signature" (Tasks 2, 5, 6) — that is a deliberate guard because `admin.ts`/`save.ts` exact export shapes were not fully quoted here; the grep in each task's Step 1 resolves them before code is written. Not a TODO — an ordering instruction.

**Type/consistency:** `splitAlts`/`joinAlts` (Task 5) are named consistently across parse + serialize + render sites. Task 6 threads one optional `thenNavigate`/`navigate` param consistently between test and impl. Task 1 changes only the I/O call, no signature churn. No cross-task symbol collisions (independent files; only `docs/DEFERRED.md` and possibly `src/templates/admin.ts` are touched by more than one task — Tasks 2 and 3 both edit admin.ts but in disjoint regions, and each commits separately).

**Ordering note:** Tasks 2 and 3 both modify `src/templates/admin.ts`. Execute 2 then 3 (or rebase) so the second sees the first's change; their regions don't overlap (Position select vs the width/aspect/fit/autoplay block).
