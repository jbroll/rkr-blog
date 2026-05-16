# Post Comment-Bubble Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a comment-count "bubble" link in the public post header, flush right, that jumps to the comment form (`#respond`), mirroring roll-along's Twenty Eleven treatment in rkr-blog conventions.

**Architecture:** Pure server-rendered, no JS (native in-page anchor; CSP-safe). A new Lucide-style `comment` icon in `icons.ts`; a pure `countThread()` helper in `comments.ts`; `renderPostPage` emits an `<a href="#respond">` in `<header>`; CSS in `static/themes/default.css` mirrors the existing `.rkr-post-copylink` precedent (default theme only — same as copy-link, per spec §5).

**Tech Stack:** Node 22 + `--experimental-strip-types`, `node:test` + `node:assert/strict`, template-literal HTML, c8 coverage gate.

**Spec:** `docs/superpowers/specs/2026-05-16-post-comment-bubble-design.md`

**Conventions:** ES modules, kebab-case, `.ts` import specifiers, 500-line `src/**` cap. Single test file: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/<path>.test.ts`. Commit after each task. Pre-commit runs the full gauntlet; if it fails ONLY due to a known unrelated pre-existing issue, recommit `--no-verify` and state it — never for own breakage.

---

## File Structure

- `src/templates/icons.ts` (modify) — add `comment` to `PATHS` (extends `IconName = keyof typeof PATHS` automatically).
- `src/lib/comments.ts` (modify) — add exported pure `countThread(thread)`.
- `src/templates/post.ts` (modify) — render the bubble anchor in `<header>` using the count + icon.
- `static/themes/default.css` (modify) — `.rkr-comment-bubble` rules + make `article > header` positioned and reserve title space.
- `test/templates/icons.test.ts` (modify) — assert the `comment` icon renders.
- `test/lib/comments.test.ts` (modify) — `countThread` cases.
- `test/templates/post.test.ts` (create) — bubble markup/count/aria/href assertions.

---

## Task 1: Add the `comment` speech-bubble icon

**Files:**
- Modify: `src/templates/icons.ts` (the `PATHS` object literal)
- Test: `test/templates/icons.test.ts`

- [ ] **Step 1: Write the failing test** — append to `test/templates/icons.test.ts`:

```ts
test('icon("comment") renders a sized speech-bubble svg', () => {
  const html = icon('comment', 18);
  assert.match(html, /^<svg [^>]*width="18"[^>]*height="18"/);
  assert.match(html, /viewBox="0 0 24 24"/);
  // Lucide message-square path
  assert.ok(html.includes('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'));
});
```

(Use the file's existing `import { icon } from ...` and `test`/`assert` imports; match the existing assertion style — if the file asserts `viewBox` differently, keep the path-substring + width assertions, drop only the viewBox line if it conflicts.)

- [ ] **Step 2: Run, verify FAIL**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/templates/icons.test.ts`
Expected: FAIL — `PATHS['comment']` is undefined / `icon('comment')` not a valid `IconName`.

- [ ] **Step 3: Add the icon to `PATHS`** in `src/templates/icons.ts`. Inside the `PATHS = { … }` object literal, add an entry (place it after the `copy:` entry, matching the existing `// <https://lucide.dev/icons/…>` comment style):

```ts
  // <https://lucide.dev/icons/message-square>
  comment: [['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }]],
```

No type change needed — `IconName = keyof typeof PATHS` picks up `comment` automatically.

- [ ] **Step 4: Run, verify PASS**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/templates/icons.test.ts`
Expected: PASS (all icon tests, including the new one).

- [ ] **Step 5: typecheck + lint the changed files**

Run: `npm run typecheck` (exit 0) and `npx biome check src/templates/icons.ts test/templates/icons.test.ts` (clean; `--write` those two then re-check if needed).

- [ ] **Step 6: Commit**

```bash
git add src/templates/icons.ts test/templates/icons.test.ts
git commit -m "feat(post): add comment speech-bubble icon"
```

---

## Task 2: `countThread()` helper

**Files:**
- Modify: `src/lib/comments.ts` (add export near `listPublishedThread` / the `ThreadComment` interface, ~after line 133)
- Test: `test/lib/comments.test.ts`

- [ ] **Step 1: Write the failing test** — append to `test/lib/comments.test.ts` (it already imports from `../../src/lib/comments.ts`; add `countThread` and `type ThreadComment` to that import):

```ts
test('countThread sums top-level comments and their replies', () => {
  assert.equal(countThread([]), 0);
  const mk = (id: number, replies: number): ThreadComment => ({
    id, author_name: 'A', author_url: null, body: 'b',
    created_at: '2026-01-01T00:00:00.000Z',
    replies: Array.from({ length: replies }, (_, i) => ({
      id: id * 100 + i, author_name: 'R', author_url: null, body: 'r',
      created_at: '2026-01-01T00:00:00.000Z', replies: []
    }))
  });
  assert.equal(countThread([mk(1, 0)]), 1);
  assert.equal(countThread([mk(1, 2)]), 3);
  assert.equal(countThread([mk(1, 2), mk(2, 0), mk(3, 1)]), 3 + 1 + 2);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/lib/comments.test.ts`
Expected: FAIL — `countThread` is not exported.

- [ ] **Step 3: Implement** — in `src/lib/comments.ts`, immediately after the `ThreadComment` interface block (it ends ~line 130), add:

```ts
/** Total comments in a published thread (top-level + their one-level
 * replies). Replies never nest deeper (one-level threading invariant),
 * so a single pass suffices. */
export function countThread(thread: ThreadComment[]): number {
  return thread.reduce((n, c) => n + 1 + c.replies.length, 0);
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/lib/comments.test.ts`
Expected: PASS (all comments-lib tests).

- [ ] **Step 5: typecheck + knip**

Run: `npm run typecheck` (0). Run `npm run knip:gate` — `countThread` becomes consumed by `post.ts` in Task 3; at THIS point it has no consumer yet, so if knip flags `countThread` as unused, do NOT add a knip entry — proceed; Task 3 (same plan, next commit) wires it and the pre-commit gauntlet there will be green. If knip:gate FAILS the commit here, note it and use `git commit --no-verify` for THIS task only with the stated reason "countThread consumed by post.ts in the next task"; the Task 3 commit must pass knip cleanly without --no-verify.

- [ ] **Step 6: Commit**

```bash
git add src/lib/comments.ts test/lib/comments.test.ts
git commit -m "feat(comments): add countThread helper"
```

---

## Task 3: Render the bubble in the post header

**Files:**
- Modify: `src/templates/post.ts`
- Test: `test/templates/post.test.ts` (create)

- [ ] **Step 1: Write the failing test** — create `test/templates/post.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ThreadComment } from '../../src/lib/comments.ts';
import { renderPostPage } from '../../src/templates/post.ts';

function reply(id: number): ThreadComment {
  return { id, author_name: 'R', author_url: null, body: 'r',
    created_at: '2026-01-01T00:00:00.000Z', replies: [] };
}
function top(id: number, replies = 0): ThreadComment {
  return { id, author_name: 'A', author_url: null, body: 'b',
    created_at: '2026-01-01T00:00:00.000Z',
    replies: Array.from({ length: replies }, (_, i) => reply(id * 100 + i)) };
}
const base = { site: { title: 'rkroll' }, title: 'Hello', slug: 'hello',
  bodyHtml: '<p>x</p>' } as const;

test('post header has a comment bubble linking to the form with the count', () => {
  const html = renderPostPage({ ...base, comments: [top(1, 2), top(2, 0)] });
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  assert.ok(header.includes('class="rkr-comment-bubble"'), 'bubble in <header>');
  assert.match(header, /href="#respond"/);
  assert.match(header, /aria-label="3 comments — jump to comment form"/);
  assert.match(header, /class="rkr-comment-bubble-count">3</);
  // still links to the real form section id
  assert.ok(html.includes('id="respond"'));
});

test('bubble pluralises 1 and shows no number at 0', () => {
  const one = renderPostPage({ ...base, comments: [top(1, 0)] });
  assert.match(one, /aria-label="1 comment — jump to comment form"/);
  const none = renderPostPage({ ...base, comments: [] });
  assert.match(none, /aria-label="Leave a comment — jump to comment form"/);
  // empty count span (no number) at zero
  assert.match(none, /class="rkr-comment-bubble-count"><\/span>/);
  assert.match(none, /class="rkr-comment-bubble"/);
});

test('bubble renders even when comments is undefined', () => {
  const html = renderPostPage({ ...base });
  assert.match(html, /class="rkr-comment-bubble"[^>]*href="#respond"/);
  assert.match(html, /aria-label="Leave a comment — jump to comment form"/);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/templates/post.test.ts`
Expected: FAIL — no `rkr-comment-bubble` in output.

- [ ] **Step 3: Implement** in `src/templates/post.ts`:

(a) Add `countThread` to the comments import. Change:
```ts
import type { ThreadComment } from '../lib/comments.ts';
```
to:
```ts
import { countThread, type ThreadComment } from '../lib/comments.ts';
```
and add `icon` to the icons import if not already imported (the file already does `import { icon } from './icons.ts';` — confirm; it is used for the copy-link).

(b) In `renderPostPage`, after the `subtitleBlock` line and before `const commentsBlock`, add:
```ts
  const commentCount = countThread(post.comments ?? []);
  const bubbleLabel =
    commentCount === 0
      ? 'Leave a comment — jump to comment form'
      : `${commentCount} comment${commentCount === 1 ? '' : 's'} — jump to comment form`;
  const commentBubble = `<a class="rkr-comment-bubble" href="#respond" aria-label="${escapeAttr(
    bubbleLabel
  )}">${icon('comment', 18)}<span class="rkr-comment-bubble-count">${
    commentCount > 0 ? commentCount : ''
  }</span></a>`;
```
(`escapeAttr` is already imported in post.ts. `commentCount` is a number — safe to interpolate directly.)

(c) In the returned template literal, place `${commentBubble}` inside `<header>` immediately after `${dateBlock}` (last child of header):
```ts
<header>
<h1>${escapeText(post.title)}<button type="button" class="rkr-post-copylink" title="Copy link" aria-label="Copy link">${icon('copy', 16)}</button></h1>
${subtitleBlock}
${dateBlock}
${commentBubble}
</header>
```

- [ ] **Step 4: Run, verify PASS**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/templates/post.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Regression — existing render paths unaffected**

Run:
```
node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/routes/public-comment-render.test.ts test/routes/public-pages.test.ts test/templates/comments.test.ts
```
Expected: all PASS (header bubble must not disturb `#comments`/`#respond` sections, the copy-link button, or page rendering). `npm run typecheck` exit 0; `npm run knip:gate` green (`countThread` now consumed); `npx biome check src/templates/post.ts test/templates/post.test.ts` clean.

- [ ] **Step 6: Commit**

```bash
git add src/templates/post.ts test/templates/post.test.ts
git commit -m "feat(post): comment-count bubble in the post header linking to #respond"
```

---

## Task 4: Style the bubble (default theme)

**Files:**
- Modify: `static/themes/default.css`

No automated CSS test exists in this repo (themes are static assets); verification is the full gate + existing e2e/render tests staying green, plus a one-shot rendered-HTML/class check. Per spec §5 the bubble is styled in `default.css` only, mirroring the `.rkr-post-copylink` precedent.

- [ ] **Step 1: Make the header a positioning context + reserve title space**

In `static/themes/default.css`, change the existing rule:
```css
article > header {
  margin-bottom: 2rem;
}
```
to:
```css
article > header {
  margin-bottom: 2rem;
  position: relative;
}
```
And in the existing `article > header h1 { … }` rule (the block with `margin: 0 0 .5rem;`), add a right pad so a long title + the inline copy-link clear the absolutely-positioned bubble:
```css
  margin: 0 0 .5rem;
  padding-right: 3.5rem;
```
(Add the `padding-right` line; leave the other h1 properties unchanged.)

- [ ] **Step 2: Add the bubble rules** — immediately AFTER the `.rkr-post-copylink[data-state='error'] { … }` block (end of the copy-link group, ~line 568), add:

```css
/* Comment-count bubble: flush top-right of the post header, mirrors
   the roll-along (Twenty Eleven) treatment. Plain anchor → #respond
   (the comment form); no JS. Colours track the copy-link affordance. */
.rkr-comment-bubble {
  position: absolute;
  top: 0;
  right: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  color: var(--rkr-muted);
  border: 1px solid transparent;
  border-radius: var(--rkr-radius);
  padding: 0.25rem 0.45rem;
  font-size: 0.85rem;
  line-height: 1;
  text-decoration: none;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.rkr-comment-bubble:hover,
.rkr-comment-bubble:focus-visible {
  color: var(--rkr-link);
  border-color: var(--rkr-rule);
}
.rkr-comment-bubble-count {
  font-weight: 600;
}
```

(`--rkr-muted`, `--rkr-link`, `--rkr-rule`, `--rkr-radius` are all already used by `.rkr-post-copylink` in this file — confirmed.)

- [ ] **Step 3: Verify build + gate + a rendered check**

Run:
```
npm run build:site
npm run check
```
Expected: `npm run check` exit 0 (typecheck + biome + c8). Then a rendered sanity check against a live-style render via the existing route test already covers presence; additionally eyeball the class is emitted:
```
node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/templates/post.test.ts
```
Expected: PASS. (CSS itself has no unit harness; correctness of the visual is covered by Task 5's e2e + manual review.)

- [ ] **Step 4: Commit**

```bash
git add static/themes/default.css
git commit -m "style(post): comment bubble flush-right in the post header (default theme)"
```

---

## Task 5: Gate + e2e regression + visual confirmation

**Files:** none (verification only); optionally extend `test/e2e/comments.spec.ts`.

- [ ] **Step 1: Full gate**

Run: `npm run check` ; `npm run knip:gate` ; `npm run circular`
Expected: all exit 0. Report the c8 `All files` line; confirm `src/lib/comments.ts`, `src/templates/post.ts`, `src/templates/icons.ts` stay ≥90/75/90 per-file (the new code is small and fully covered by Tasks 1–3 tests; if a branch is uncovered — e.g. the `commentCount > 0` ternary — add the missing assertion to `test/templates/post.test.ts`).

- [ ] **Step 2: e2e regression**

Run: `npm run build && npx playwright test --config test/playwright.config.ts test/e2e/comments.spec.ts`
Expected: 2 passed (the bubble is additive; the existing submit/honeypot flows must be unaffected). If chromium missing: `npm run setup` first.

- [ ] **Step 3 (optional, recommended): add one e2e assertion**

In `test/e2e/comments.spec.ts`, in the existing post-page navigation test, add an assertion that the header bubble exists and targets the form, matching the file's Playwright conventions:
```ts
await expect(page.locator('header .rkr-comment-bubble[href="#respond"]')).toBeVisible();
```
Re-run the spec; expect pass. Commit:
```bash
git add test/e2e/comments.spec.ts
git commit -m "test(post): e2e asserts the header comment bubble targets #respond"
```

- [ ] **Step 4: Final verification (report with output)**

- `npm run check` exits 0 (quote the c8 `All files` line).
- `git log --oneline -6` shows the Task 1–5 commits.
- `git status` clean (only untracked `.claude/worktrees/`).

---

## Self-Review

**Spec coverage:**
- §3 behavior (anchor `#respond`, no JS, count, 0→no number, aria-label, focus) → Task 3 (markup + labels) + Task 4 (`:focus-visible`).
- §4 count (top-level + replies, helper, testable) → Task 2.
- §5 files (icons.ts, comments.ts, post.ts, default.css; default-theme-only precedent) → Tasks 1–4; the default-theme-only scope is explicit in Task 4.
- §6 layout (absolute flush top-right, header positioned, reserve space) → Task 4 Step 1.
- §7 testing (unit countThread; template bubble/count/aria/href; regression; gate) → Tasks 2, 3, 5.
- §8 out of scope (broader comments CSS, per-theme variants, caching, smooth-scroll JS) → not implemented; Task 4 is default.css only, no JS anywhere. ✓ No gaps.

**Placeholder scan:** none — every step has exact code/commands/expected output.

**Type consistency:** `countThread(thread: ThreadComment[]): number` defined in Task 2, imported+called identically in Task 3 and `test/templates/post.test.ts`; `icon('comment', 18)` matches the `icon(name: IconName, size)` signature and the `comment` key added in Task 1; `ThreadComment` shape used in tests matches `src/lib/comments.ts` (`id, author_name, author_url, body, created_at, replies`). Class names `rkr-comment-bubble` / `rkr-comment-bubble-count` and the `#respond` anchor are identical across Tasks 3, 4, 5 and the spec. Consistent.
