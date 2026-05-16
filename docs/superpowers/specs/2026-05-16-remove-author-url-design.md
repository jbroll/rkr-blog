# Remove `authorUrl` + Fix Honeypot — Design Spec

**Date:** 2026-05-16
**Status:** Approved (brainstorming) — pending spec review
**Repo:** `rkr-blog` only
**Source:** User decision (2026-05-16): the comment form needs only Name,
Email, Comment; the website field is unwanted; the honeypot is currently
visible and silently rejecting legitimate comments.

## 1. Goals

Two related fixes to the comment subsystem, shipped together:

1. **Remove `authorUrl` / `author_url` end to end** — schema, lib,
   routes, templates, WP import, and the spam-classifier input. New web
   comments collect only **Name, Email, Comment**; comment author names
   render as plain text (no website link).
2. **Fix the honeypot** — it is currently visible (no comment-form CSS
   was ever shipped), so a real reader who fills the decoy "Website"
   field has their comment **silently discarded**. Keep the honeypot as
   the cheap pre-LLM bot trap, but make it reliably hidden across all
   themes.

Out of scope (explicitly): broader comment-form layout / explanatory
copy / comment-list styling — a separate later item. This change is
authorUrl-removal + honeypot-hide only.

## 2. Context (verified)

- `node:sqlite` bundles **SQLite 3.50.4** → `ALTER TABLE … DROP COLUMN`
  is supported; no table-rebuild needed. The migrate runner wraps each
  migration body in a transaction; `DROP COLUMN` in a transaction is
  fine in modern SQLite.
- Production `schema_migrations = 1,2,3,4`; `comments` table has **0
  rows** (recovery import never run; smoke-test row deleted). Dropping
  the column is **zero data loss**. Migrations are forward-only and
  `004` is already applied on prod, so `004` must NOT be edited — a new
  `005` is required (a fresh DB will create-then-drop; harmless).
- `static/base.css` is loaded on **every** page, before any theme
  (`stylesheetLinks()` in `layout.ts` always emits base.css +
  default.css, plus the active theme if non-default). It is the
  correct, theme-independent home for the functional honeypot-hide rule
  (a visible honeypot under a non-default theme would be a *functional*
  bug, not cosmetic).
- Public CSP allows `style-src 'self' 'unsafe-inline'`; a `base.css`
  rule is cleaner than an inline style and is the chosen approach.

## 3. authorUrl removal — file by file

- **Create `src/migrations/005_drop_comment_author_url.sql`:**
  ```sql
  -- The comment form no longer collects a website; author_url is unused.
  ALTER TABLE comments DROP COLUMN author_url;
  ```
- **`src/lib/comments.ts`:** remove `author_url`/`authorUrl` from
  `CommentRow`, `NewWebComment`, `ImportedComment`, `ThreadComment`; from
  the `INSERT` column lists + bound params in `insertWebComment` and
  `insertImportedComment`; from the `SELECT` and the node-construction in
  `listPublishedThread`. (`ModerationRow` does not reference it.)
- **`src/routes/public-comments.ts`:** remove the `url` field read, its
  `MAX.url` length cap, and the `authorUrl` argument to
  `insertWebComment`.
- **`src/templates/comments.ts`:** in `renderCommentForm`, remove the
  `<label>Website (optional)<input … name="url" …></label>` input. In
  `renderCommentList`, remove the `authorHtml(...)` link helper and
  render the author name as plain `escapeText(name)` always (no
  `<a rel="nofollow ugc noopener">`). Drop the now-unused `authorHtml`
  function and its `escapeAttr` usage if it becomes unused.
- **`src/cli/import-wp-comments.ts`:** stop mapping WP `author_url`;
  `insertImportedComment` no longer takes `authorUrl`.
- **`src/lib/wp-rest.ts`:** remove `author_url` from the `listComments`
  `_fields` list.
- **`src/lib/wp-import-types.ts`:** remove `author_url` from `WpComment`.
- **Spam classifier (behavior change, intentional):**
  - `src/lib/spam-classifier.ts`: remove `authorUrl` from `SpamInput`
    and delete the `Author website: …` line from the pinned prompt.
  - `src/lib/classify-handler.ts`: remove `authorUrl` from the
    `Classifier` input type and stop passing `comment.author_url`.
  The author website was a weak spam signal and the field no longer
  exists; the prompt is otherwise unchanged.

## 4. Honeypot fix

The honeypot markup in `renderCommentForm` is unchanged:
`<div class="rkr-hp" aria-hidden="true"><label>Website<input
type="text" name="website" tabindex="-1" autocomplete="off"/></label>
</div>`. Add the missing rule to **`static/base.css`** (always loaded,
theme-independent):

```css
/* Honeypot: keep the field in the DOM + submittable so bots fill it,
   but never visible/focusable for humans or screen readers. NOT
   display:none (some bots skip display:none inputs). */
.rkr-hp {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
```

This stops the silent rejection of legitimate comments under every
theme, preserves the layered defense (honeypot → min-fill-time →
rate-limit → Ollama classifier), and the route logic is unchanged
(non-empty `website` → silent 303, no row — now only bots hit it).

## 5. Tests & docs

- **`test/lib/comments.test.ts`**, **`test/lib/classify-handler.test.ts`**,
  **`test/lib/spam-classifier.test.ts`**, **`test/templates/post.test.ts`**,
  **`test/templates/comments.test.ts`**, **`test/routes/public-comments.test.ts`**,
  **`test/routes/public-comment-render.test.ts`**,
  **`test/routes/admin-comments.test.ts`**,
  **`test/cli/import-wp-comments.test.ts`**,
  **`test/lib/wp-rest-comments.test.ts`**: drop `authorUrl`/`author_url`
  from fixtures, types, and assertions. Rewrite/remove the
  `import-wp-comments` "author_url empty → null" test and any assertion
  that the author name renders as a link. Update the comment-form test
  to assert there is **no** `name="url"` input and the form has exactly
  Name/Email/Comment (+ hidden honeypot/parent/t).
- **`test/lib/migrate.test.ts`**: expected applied versions
  `[1,2,3,4]` → `[1,2,3,4,5]`; if it asserts the `comments` columns,
  drop `author_url`.
- Add a focused migration test (extend `migrate.test.ts` or
  `comments.test.ts`): after `migrate()`, `comments` has no
  `author_url` column (`PRAGMA table_info(comments)`), and
  `insertWebComment` / `insertImportedComment` succeed without it.
- Add/extend a honeypot test if feasible at the unit level (the route
  test already covers "honeypot filled → silent 303, no row"); a
  template assertion that the honeypot input still renders with
  `class="rkr-hp"` and the `base.css` rule exists is sufficient (no CSS
  unit harness — the rule's presence in `static/base.css` is the check).
- **Update `docs/superpowers/specs/2026-05-16-blog-comments-design.md`**
  to reflect: no `author_url` column/field; form = Name/Email/Comment;
  author names plain text; honeypot hidden via base.css; classifier
  prompt no longer includes author website.
- Remove the now-resolved concern from `docs/DEFERRED.md` if an entry
  exists for the visible honeypot / form; otherwise no DEFERRED change.

## 6. Risks / mitigations

- **Migration on a fresh DB** runs `004` (adds `author_url`) then `005`
  (drops it) — wasteful but correct and conventional for forward-only
  migrations. Acceptable; do not edit `004`.
- **Imported WP comments** will no longer carry a website link
  (author_url not stored). Accepted per the user decision (website
  removed entirely); imported comments still render name + body + date.
- **Classifier prompt change** slightly alters spam scoring inputs;
  acceptable (weak signal, field removed). The fail-safe (timeout/error
  → `queued`) and verdict-keyed publish/queue logic are unchanged.
- Full gate (`npm run check` / knip / circular) must pass; the e2e
  `comments.spec.ts` submit/honeypot/bubble flows must still pass.

## 7. Net result

Comment form: **Name, Email, Comment** (plus hidden honeypot, hidden
`parent_id`, hidden `t`). No website field. Author names render as
plain text. The honeypot is invisible to humans under all themes and no
longer silently drops legitimate comments. `comments.author_url` no
longer exists in schema or code.
