# Post Comment-Bubble — Design Spec

**Date:** 2026-05-16
**Status:** Approved (brainstorming) — pending spec review
**Source:** `docs/DEFERRED.md` → "User-requested follow-ups (2026-05-16)" →
"Comment bubble floated right in the post title"
**Repo:** `rkr-blog` only

## 1. Goal

Add a comment-count "bubble" affordance to the public post header, flush
right, that links to the comment form at the bottom of the page —
mirroring the Twenty Eleven treatment on the reference site
`roll-along.rkroll.com`, implemented with rkr-blog conventions.

Today the post page has no in-header cue that comments exist or a quick
way to jump to them; the comment list/form are only a section at the
bottom of `<main>`.

## 2. Reference (what we are mirroring)

`roll-along.rkroll.com` runs the WordPress **Twenty Eleven** theme. Its
`.comments-link a` is a small rounded speech bubble, `position:absolute;
top; right:0` of the post `entry-header`, showing the approved-comment
count, linking to the comments anchor; `.entry-header{min-height}`
reserves space so the bubble never collides with the title. We mirror
the *visual treatment and placement*, not the literal markup/PNG
(rkr-blog uses inline-SVG icons, theme CSS variables, and a strict CSP).

## 3. Behavior

- A single element in the post `<header>`: `<a href="#respond">` —
  a native in-page anchor jump to the comment **form** (the comment
  form section already has `id="respond"` in `src/templates/comments.ts`
  and is always rendered, even with zero comments). No JavaScript; the
  strict public CSP is unaffected.
- Visually: a speech-bubble SVG icon with the **published comment count**
  centered on/over it. Count `0` → the bubble renders with no number
  (still links to the form — "be the first"), matching Twenty Eleven.
- Always rendered; identical for anonymous and admin viewers.
- Accessibility: the anchor carries an `aria-label` of the form
  `"<N> comments — jump to comment form"` (and `"Leave a comment —
  jump to comment form"` when count is 0); visible `:focus-visible`
  ring; hover/focus color = the theme accent, matching
  `.rkr-post-copylink`.

## 4. Count semantics

Count = total **published** comments for the post = top-level comments +
their published replies (mirrors WordPress "all approved"). Source is the
`post.comments` thread (`ThreadComment[]`) already passed to
`renderPostPage`.

A small pure helper is added so the count is testable in isolation:

```ts
// src/lib/comments.ts
/** Total comments in a published thread (top-level + one-level replies). */
export function countThread(thread: ThreadComment[]): number {
  return thread.reduce((n, c) => n + 1 + c.replies.length, 0);
}
```

(One reply level only — consistent with the one-level threading invariant
of the comments feature; `replies` never nest deeper.)

## 5. Components / files

- **`src/templates/icons.ts`** — add a new `comment` speech-bubble inline
  SVG, following the existing `icon(name, size)` pattern (stroke-based,
  same style family as `copy` / `link`). Extends the `IconName` union.
- **`src/lib/comments.ts`** — add `countThread()` (pure, exported).
- **`src/templates/post.ts`** — in `renderPostPage`, compute
  `const commentCount = countThread(post.comments ?? [])` and render the
  bubble anchor inside `<header>` (sibling of `<h1>`/subtitle/date). The
  anchor: `<a class="rkr-comment-bubble" href="#respond"
  aria-label="…">{icon('comment', …)}<span
  class="rkr-comment-bubble-count">{N or ''}</span></a>`. The numeric
  count needs no escaping; the `aria-label` text is built from the number
  only (no user input).
- **`static/themes/default.css`** — add a `.rkr-comment-bubble`
  (+ `.rkr-comment-bubble-count`) block adjacent to the existing
  `.rkr-post-copylink` rules (~line 545). `<header>` gets
  `position: relative` and enough right padding / min-height that the
  title text and the existing inline copy-link button never run under
  the absolutely-positioned bubble (the Twenty Eleven technique). Colors
  use the theme accent/link variable already used by `.rkr-post-copylink`;
  hover/focus mirror it.

**Convention note (from codebase exploration):** `.rkr-post-copylink` is
styled **only** in `static/themes/default.css`; the other 7 themes do not
theme it, and there is currently no `.rkr-comment*` CSS anywhere. We
mirror that exact precedent — bubble styled in `default.css` only. Per-
theme bubble variants for the other 7 themes are **out of scope**
(consistent with how the existing copy-link button is handled — YAGNI).

## 6. Layout decision

Absolutely-positioned, flush top-right of `<header>` (header set
`position: relative`). Rejected alternative: inline inside `<h1>` after
the copy-link button — simpler markup but the two right-aligned controls
contend on long titles and it diverges from the roll-along top-right
placement. The absolute approach matches the reference and is robust to
title length.

## 7. Testing

- **Unit (`test/lib/comments.test.ts`):** `countThread` — empty → 0;
  top-level only; top-level + replies summed; multiple top-level with
  mixed replies.
- **Template (`test/templates/`):** `renderPostPage` (or a focused
  test) asserts the header contains `class="rkr-comment-bubble"`,
  `href="#respond"`, the correct count text for N>0, no number for N=0,
  and the count-appropriate `aria-label`.
- **Regression:** existing `test/routes/public-comment-render.test.ts`
  and post-template tests still pass (bubble added to the header must
  not break the rendered `#comments`/`#respond` sections or the
  copy-link button).
- Full gate (`npm run check` / knip / circular) green; new exports
  reachable (no spurious knip entry).

## 8. Out of scope

Styling the broader comments list/form (no `.rkr-comment*` CSS exists
yet — a separate concern), per-theme bubble variants for the non-default
themes, comment-count caching, smooth-scroll JS (native anchor only),
and the unrelated drag-reorder DEFERRED item.
