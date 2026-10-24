# Unified block editor — design (2026-10-23)

Intent: one page that is both the editor and the preview. Authors see
exactly what readers see, and edit it directly, instead of juggling a
block tree, a fields panel, and a separate preview iframe (which the
public security headers forbid framing anyway).

Why now: the current tree-view MVP exposes raw hex image ids and
truncated text, and its phone-preview iframe is blocked by
`frame-anchors 'none'` on public pages. Patching the iframe keeps two
surfaces in sync forever; unifying them removes the second surface.

## Goals

- Left: the live page. Right: the widget palette (Text, Image, Button,
  Row, Column, Section, macros).
- View mode is pixel-identical to the public page: same DOM, palette
  hidden, nothing editable.
- Edit mode flips the same DOM in place (no reload, no iframe):
  palette slides in on the right, text becomes directly editable,
  widgets that need more show a small config button on hover/focus.
- Type-in-place for simple parameters (e.g. text in a Markdown widget).
- Complex widgets keep full edit dialogs: figure opens its dialog
  (image picker, caption, alt, layout); macro cards open field editors.
- Save: explicit Save button plus a dirty indicator (clean / editing /
  saving / unsaved-when-offline). Every widget blur also saves that
  widget immediately, reusing the existing offline outbox path so
  offline edits queue and sync.
- Palette insert by drag into the page or click to append; same tree
  ops as today.

## Non-goals

- No free positioning or per-page custom CSS (per reusable-blocks
  design). No new runtime dependencies.
- No live multi-user editing. No macro-definition editing in this
  pass (macros stay collapsed cards with field editors).

## Anti-goals

- Never show authors raw JSON, fences, block ids, or hex image ids.
- Never fork view and edit into two render paths that can drift.
- No iframe preview (the framing fight is over by removal).

## Constraints

- Public pages keep `frame-ancestors 'none'` + `X-Frame-Options: DENY`
  unchanged. The editor shell keeps its admin CSP.
- Slugs, comment threads, and `/pages/:slug` URLs keep working; the
  JSON block-tree format is unchanged — only the editing surface is
  rebuilt. Reads/writes reuse `readBlockPage`, `POST /admin/blocks/:slug`,
  and `runReindex`-on-save.
- Figure/cell dialogs and the image pipeline are reused as-is.

## Decided: the how

1. One route, one DOM. `GET /admin/blocks/edit/:slug` renders the
   saved block tree as the public page body plus palette shell.
   A mode toggle (View | Edit) switches `contenteditable` and
   palette/config-button visibility client-side.
2. Text editing is native in-place editing; on blur the widget's
   change saves via `POST /admin/blocks/:slug` (whole-tree write,
   as today) and the indicator returns to clean.
3. Config buttons appear only where applicable (figure → dialog,
   macro → fields, text → none).
4. Palette stays a right-hand dock; drag uses the existing drop
   resolution (before/after/inside), click appends at end.
5. Dirty indicator is honest state, not a timer: editing (local
   changes since last save round-trip), saving (request in flight),
   unsaved (failed or queued offline).

## Left to the builder

- Toggle placement/copy and keyboard shortcut for View/Edit.
- Dirty-indicator visuals and the exact offline/queued wording.
- Blur-save debounce timing vs immediate write; failure retry UI.
- Phone-width preview handling now that the iframe is gone
  (e.g. a width switch narrowing the same page, or defer).
- Whether macro field editors are inline popovers or dialogs.
- Plan staging after this doc is approved.
