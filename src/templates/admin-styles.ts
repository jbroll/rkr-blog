// Admin SPA stylesheet. Extracted from admin.ts so the page
// template stays under the 500-line size cap; the rules here are
// scoped under #rkroll-admin-root / its sibling overlays.

export const ADMIN_CSS = `
  /* The editor body fills the viewport like the public pages so the
     site-head strip can span edge-to-edge. The admin content sits
     inside .rkr-admin-content (added in admin.ts) which carries the
     56rem / 2rem-margin constraint the body used to. The editable
     prose preview lives inside <article> below, where site.css's
     prose rules apply naturally. */
  body {
    background: var(--rkr-bg, #fff);
    color: var(--rkr-text, #1a1a1a);
  }
  .rkr-admin-content {
    max-width: 56rem;
    margin: 2rem auto;
    padding: 0 1rem;
  }
  /* Admin chrome uses system-ui; site.css's serif still applies to
     the editable article. */
  body, button, input, select { font-family: system-ui, sans-serif; }
  /* When any editor dialog is open the document behind it must stop
     scrolling — native <dialog> renders in the top layer but doesn't
     lock the body, so wheel / touch scroll still moves the article
     underneath. body:has() catches the open state without JS, and
     overscroll-behavior: contain on the dialog itself stops the
     scroll chain when the author reaches the top/bottom of the
     dialog's own scroll region (e.g. the cell dialog's preview
     image). */
  body:has(dialog[open]) {
    overflow: hidden;
  }
  dialog {
    overscroll-behavior: contain;
    max-height: 90vh;
    overflow-y: auto;
  }
  /* Suppress the OS cut-copy-paste overlay outside prose-editable
     surfaces; long-pressing a toolbar button shouldn't pop the menu.
     Form fields + contenteditable re-enable text selection; images
     need -webkit-touch-callout: none so iOS doesn't open "Save image"
     on long-press inside the figure-config flow. */
  .rkr-admin-content,
  .rkr-admin-content button,
  #rkr-page-title,
  #rkroll-admin-toolbar,
  #rkr-sync-badge,
  #rkroll-admin-article .rkr-figure-actions,
  .rkr-cell-dialog-head,
  .rkr-cell-dialog-body > label {
    user-select: none;
    -webkit-user-select: none;
  }
  #rkroll-admin-status {
    user-select: none;
    -webkit-user-select: none;
  }
  #rkroll-admin-status.is-error {
    user-select: text;
    -webkit-user-select: text;
  }
  .rkr-admin-content :is(input, textarea, [contenteditable='true']),
  .rkr-admin-content :is(input, textarea, [contenteditable='true']) * {
    user-select: text;
    -webkit-user-select: text;
  }
  #rkroll-admin-article img, .rkr-cell-preview, dialog img {
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  /* Commit any touch-drag in the editor to vertical scroll, so
     Firefox Android stops popping the OS action bar mid-scroll with
     an empty range. Long-press-to-select still works (not a drag). */
  #rkroll-admin-article { touch-action: pan-y; }
  /* Figure placeholder is inside contenteditable="true"; without
     user-select:none its grid gaps become text-selectable. */
  #rkroll-admin-article .rkr-multi,
  #rkroll-admin-article .rkr-multi * {
    user-select: none; -webkit-user-select: none;
    -moz-user-select: none; -ms-user-select: none;
    -webkit-touch-callout: none; touch-action: pan-y;
  }
  /* Reorder: thumb must claim the gesture (pan-y above would let the
     page scroll instead of letting the finger drag). */
  #rkroll-admin-article .rkr-multi-thumb { touch-action: none; }
  #rkroll-admin-article .rkr-multi-thumb:focus-visible {
    /* Fallback required: the admin editor does not define --rkr-link,
       so a bare var() resolves to nothing (invisible). base.css uses
       the same #1a4f7f fallback convention. */
    outline: 2px solid var(--rkr-link, #1a4f7f);
    outline-offset: 2px;
  }
  #rkroll-admin-article .rkr-multi-thumb.is-dragging {
    opacity: .3;
    outline: 2px dashed var(--rkr-link, #1a4f7f);
    outline-offset: -2px;
  }
  /* Bold insertion bar at the drop slot — absolutely positioned in the
     thumb grid (which must be a positioned ancestor). Deliberately
     prominent: the dragged image is a separate floating clone, so this
     is the user's primary "where will it land" cue. */
  #rkroll-admin-article .rkr-multi-thumbs { position: relative; }
  #rkroll-admin-article .rkr-multi-drop-indicator {
    position: absolute;
    width: 5px;
    margin-left: -2px;
    background: var(--rkr-link, #1a4f7f);
    border-radius: 3px;
    /* Dual ring — light inner + dark outer — so the bar keeps contrast
       on both a white and a dark editor background, plus a coloured
       glow. (The old single #fff ring was the only thing rendering
       because the bar background var had no fallback → transparent.) */
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, .9),
      0 0 0 2px rgba(0, 0, 0, .55),
      0 0 6px var(--rkr-link, #1a4f7f);
    pointer-events: none;
    z-index: 3;
  }
  /* Floating drag clone: a copy of the thumbnail that tracks the
     pointer. Appended to <body> (outside the editor), so the selector
     is unscoped, like .rkr-multi-status. */
  .rkr-multi-drag-clone {
    position: fixed;
    top: 0;
    left: 0;
    margin: 0;
    object-fit: cover;
    pointer-events: none;
    opacity: .85;
    border-radius: 4px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, .35);
    z-index: 2147483647;
  }
  /* Visually-hidden reorder status (announced via aria-live).
     figure-reorder.ts appends this to <body>, NOT inside
     #rkroll-admin-article, so the selector must be unscoped. */
  .rkr-multi-status {
    position: absolute; width: 1px; height: 1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
  }
  /* Mode label + flush-right View link on the same baseline. */
  .rkr-page-title-row {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 1rem; margin: 0 0 .75rem;
  }
  #rkr-page-title {
    font-size: 1rem; font-weight: 500; margin: 0;
    color: var(--rkr-muted, #707070);
    letter-spacing: 0.02em; text-transform: uppercase;
  }
  .rkr-page-view { font-size: .9rem; color: var(--rkr-link); text-decoration: none; }
  .rkr-page-view:hover { color: var(--rkr-link-hover); text-decoration: underline; }
  /* Admin chrome reuses site.css --rkr-* tokens; fallbacks after the
     comma cover site.css failing to load. */
  /* Sticky toolbar: pins to the viewport edge once scrolled into the
     article body. Background opaque so prose doesn't bleed through;
     the shadow only shows once pinned (when something
     has scrolled behind it), giving a subtle elevation cue. The
     <dialog> overlays sit in the top layer, so they always render
     above this regardless of z-index. Single-row layout: wrap was
     in here for the wider text labels, but the icon-only buttons
     fit on every viewport we care about (>= 320px) so we use
     overflow-x: auto as a fallback rather than dropping Save to
     its own row via the margin-left:auto interaction with wrap. */
  #rkroll-admin-toolbar {
    position: sticky; top: 0; z-index: 5;
    display: flex; gap: .25rem; flex-wrap: nowrap;
    overflow-x: auto;
    margin-bottom: 1rem; padding: .5rem;
    background: var(--rkr-bg);
    border: 1px solid var(--rkr-rule); border-radius: 4px;
    box-shadow: 0 4px 6px -4px var(--rkr-shadow, rgba(0, 0, 0, 0.08));
  }
  #rkroll-admin-toolbar button { padding: .25rem .75rem; cursor: pointer; }
  /* Icon-style toolbar buttons (Link, +Image). */
  #rkroll-admin-toolbar button svg { display: block; }
  #rkroll-admin-toolbar button.is-active { background: var(--rkr-text); color: var(--rkr-bg); }
  /* Save button: outline-only when clean, filled when .is-dirty
     (toggled by page-title.ts on editor changes). */
  #rkroll-admin-toolbar button.rkr-toolbar-primary {
    background: transparent; color: var(--rkr-link);
    border: 1px solid var(--rkr-link); padding: .25rem .85rem;
    font-weight: 500; margin-left: auto;
    transition: background-color .15s ease-out, color .15s ease-out;
  }
  #rkroll-admin-toolbar button.rkr-toolbar-primary.is-dirty {
    background: var(--rkr-link); color: var(--rkr-bg);
  }
  #rkroll-admin-toolbar button.rkr-toolbar-primary:hover {
    background: var(--rkr-link-hover); color: var(--rkr-bg);
    border-color: var(--rkr-link-hover);
  }
  /* Editor preview frame: the ProseMirror editable lives inside an
     <article>, so site.css's prose typography (max-width, font-family,
     headings, blockquotes, code, hr) applies. */
  #rkroll-admin-root {
    margin-bottom: .5rem; padding: .25rem 1rem;
    border: 1px solid var(--rkr-rule); border-radius: 4px;
    transition: border-color .1s, background .1s;
  }
  /* Visual cue while the user is dragging files over the editor.
     CSS-only via a JS-toggled class; see admin/main.ts mount(). */
  #rkroll-admin-root.is-drag-over {
    border-color: var(--rkr-link);
    background: color-mix(in srgb, var(--rkr-link) 5%, var(--rkr-bg));
  }
  /* Visible focus ring on the editable region (WCAG 2.4.7). The
     central control of the entire admin shouldn't be invisible. */
  #rkroll-admin-root .ProseMirror { min-height: 20rem; outline: none; }
  #rkroll-admin-root .ProseMirror:focus-visible {
    outline: 2px solid var(--rkr-link);
    outline-offset: 2px;
    border-radius: 2px;
  }
  /* Site.css would normally constrain article width via max-width: --rkr-prose
     and hide overflow; in the editor we let it stretch to the editable box. */
  #rkroll-admin-root article { max-width: none; margin: 0; }
  #rkroll-admin-status { margin-top: .5rem; color: var(--rkr-muted); font-size: .9rem; }
  /* Sync status badge: bottom-right of the editor frame. Click opens
     the storage panel (phase 3). Visual contract per spec-offline §8. */
  #rkroll-admin-root { position: relative; }
  #rkr-sync-badge {
    position: absolute; right: .5rem; bottom: .5rem;
    display: inline-flex; align-items: center; gap: .35rem;
    padding: .15rem .5rem;
    font: inherit; font-size: .8rem;
    background: var(--rkr-bg); color: var(--rkr-muted);
    border: 1px solid var(--rkr-rule); border-radius: 999px;
    cursor: pointer;
  }
  #rkr-sync-badge:hover { color: var(--rkr-fg); }
  .rkr-sync-dot {
    display: inline-block; width: .55rem; height: .55rem;
    border-radius: 50%; background: var(--rkr-muted);
  }
  .rkr-sync-dot.is-online { background: #2ea44f; }
  .rkr-sync-dot.is-offline { background: #cf222e; }
  .rkr-sync-dot.is-conflict { background: #cf222e; box-shadow: 0 0 0 2px color-mix(in srgb, #cf222e 30%, transparent); }
  /* Storage panel dialog (spec-offline §8). Opens from the badge
     click; renders pinned/cached/pending lists + sync-now + evict-
     all. */
  #rkr-storage-panel { padding: 1rem; min-width: 24rem; max-width: 32rem; border: 1px solid var(--rkr-rule); border-radius: 6px; }
  #rkr-storage-panel h2 { margin: 0 0 .5rem 0; }
  #rkr-storage-panel h3 { margin: .75rem 0 .25rem 0; font-size: 1rem; }
  #rkr-storage-panel ul { list-style: none; padding: 0; margin: 0; }
  #rkr-storage-panel li { display: flex; gap: .5rem; align-items: center; padding: .15rem 0; }
  #rkr-storage-panel .rkr-storage-slug { flex: 1; font-family: monospace; }
  #rkr-storage-panel .rkr-storage-when { color: var(--rkr-muted); font-size: .85rem; }
  #rkr-storage-panel .rkr-storage-empty { color: var(--rkr-muted); font-style: italic; }
  #rkr-storage-panel .rkr-storage-actions { margin-top: 1rem; display: flex; gap: .5rem; }
  #rkr-storage-close { float: right; background: none; border: none; font-size: 1.5rem; cursor: pointer; }
  #rkr-storage-schema { color: var(--rkr-muted); font-size: .8rem; margin-top: 1rem; text-align: right; }
  .rkr-meta { display: grid; grid-template-columns: max-content 1fr; gap: .5rem 1rem; margin-bottom: 1rem; align-items: center; }
  .rkr-meta input, .rkr-meta select { padding: .25rem; }
  /* Figure + cell config moved to <dialog>s opened by the in-figure
     buttons; the side panel that used to live at #rkr-figure-attrs
     is gone. Both dialogs share the .rkr-cell-dialog-* classes for
     head/close-button styling; field layout uses the grid below. */
  #rkr-figure-attrs-figure input,
  #rkr-figure-attrs-figure select,
  #rkr-figure-attrs-figure textarea { padding: .25rem; }
  /* Layout-mode label is a plain text span (no for=) so the grid still
     aligns it against the matrix control on the right column. */
  .rkr-attr-label { color: inherit; }
  /* Matrix control: a vertical stack inside the right column — a radio
     strip on top, then exactly one params row (grid / justified /
     masonry) visible at a time. */
  .rkr-matrix-control { display: flex; flex-direction: column; gap: .35rem; }
  .rkr-matrix-modes { display: flex; gap: .75rem; flex-wrap: wrap; }
  .rkr-matrix-modes label { display: inline-flex; align-items: center; gap: .25rem; }
  .rkr-matrix-params { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .rkr-matrix-params[hidden] { display: none; }
  .rkr-matrix-params input[type="number"] { width: 3rem; }
  /* Source-picker dialog: vertical button stack with a small inset. */
  /* Per-image modal: cell caption + alt + image-edit pipeline. */
  #rkr-cell-dialog {
    padding: 0;
    border: 1px solid var(--rkr-rule);
    border-radius: 6px;
    background: var(--rkr-bg);
    color: var(--rkr-text);
    max-width: min(640px, 95vw);
    width: 32rem;
  }
  #rkr-cell-dialog::backdrop,
  #rkr-figure-dialog::backdrop { background: rgba(0,0,0,.4); }
  #rkr-figure-dialog {
    padding: 0;
    border: 1px solid var(--rkr-rule);
    border-radius: 6px;
    background: var(--rkr-bg);
    color: var(--rkr-text);
    max-width: min(640px, 95vw);
    width: 32rem;
  }
  .rkr-cell-dialog-head {
    display: flex; align-items: center; justify-content: space-between;
    margin: 0; padding: .5rem .75rem;
    border-bottom: 1px solid var(--rkr-rule);
  }
  .rkr-cell-dialog-head h2 { margin: 0; font-size: 1rem; font-weight: 600; }
  .rkr-cell-dialog-close {
    background: none; border: 0; padding: .15rem .35rem; cursor: pointer;
    font: inherit; color: var(--rkr-muted);
  }
  .rkr-cell-dialog-close:hover { color: var(--rkr-text); }
  .rkr-cell-dialog-body {
    display: grid; grid-template-columns: max-content 1fr; gap: .35rem .75rem;
    align-items: center; padding: .75rem;
  }
  .rkr-cell-dialog-body #rkr-image-edit { grid-column: 1 / -1; display: contents; }
  .rkr-cell-hint { grid-column: 1 / -1; margin: .5rem 0 0; padding: .5rem; color: var(--rkr-muted); font-style: italic; text-align: center; border: 1px dashed var(--rkr-rule); border-radius: 4px; }
  /* Live image preview inside the cell dialog. max-height keeps the
     modal from pushing past the viewport on a tall portrait crop. */
  .rkr-cell-preview {
    grid-column: 1 / -1; display: block; max-width: 100%; max-height: 45vh;
    margin: .5rem auto 0; object-fit: contain;
    background: color-mix(in srgb, var(--rkr-muted) 12%, transparent);
    border: 1px solid var(--rkr-rule); border-radius: 4px;
  }
  /* Close is FIRST in DOM order so it's the default-focused
     element on dialog open; flex order swaps the visual layout
     back to [delete][close]. Extra margin keeps the X from
     fat-finger-overlapping delete. */
  .rkr-cell-dialog-head h2 { margin-right: auto; }
  .rkr-cell-dialog-head .rkr-cell-dialog-close { order: 2; margin-left: 1.25rem; }
  .rkr-cell-dialog-head .rkr-cell-delete { order: 1; }
  /* <dialog> is at body scope, outside #rkroll-admin-root — selector
     must NOT scope to that id or the default button chrome (border,
     grey background) leaks through. */
  .rkr-cell-delete {
    background: none; border: 0; padding: .25rem; cursor: pointer;
    color: var(--rkr-muted); display: inline-flex; align-items: center;
    line-height: 1;
  }
  .rkr-cell-delete:hover,
  .rkr-cell-delete:focus-visible { color: var(--rkr-danger); }
  #rkr-source-picker { padding: 1rem 1.25rem; border: 1px solid var(--rkr-rule); border-radius: 6px; }
  #rkr-source-picker h2 { margin: 0 0 .5rem; font-size: 1rem; }
  #rkr-source-picker .rkr-source-actions { display: flex; flex-direction: column; gap: .35rem; min-width: 14rem; }
  #rkr-source-picker button { padding: .4rem .75rem; cursor: pointer; text-align: left; }
  #rkr-source-picker button[data-source=""] { margin-top: .5rem; color: var(--rkr-muted); }
  /* Per-figure action stack: the "Add image" and "Configure" icon
     buttons sit in a narrow column to the right of the thumbs grid
     (NOT below it) so the figure's vertical real estate keeps belonging
     to the images themselves. Wired via data attributes that main.ts's
     delegated handler routes (data-add-image, data-figure-config). */
  .rkr-multi-actions {
    display: flex; flex-direction: column;
    gap: .35rem; align-self: start;
  }
  #rkroll-admin-root button.rkr-multi-add,
  #rkroll-admin-root button.rkr-multi-config,
  #rkroll-admin-root button.rkr-multi-delete {
    display: inline-flex;
    align-items: center; justify-content: center;
    width: 1.85rem; height: 1.85rem;
    padding: 0;
    background: transparent;
    border: 1px dashed var(--rkr-rule);
    border-radius: 4px;
    color: var(--rkr-muted);
    cursor: pointer;
  }
  #rkroll-admin-root button.rkr-multi-add:hover,
  #rkroll-admin-root button.rkr-multi-config:hover {
    color: var(--rkr-text);
    border-color: var(--rkr-text);
    border-style: solid;
  }
  #rkroll-admin-root button.rkr-multi-add svg,
  #rkroll-admin-root button.rkr-multi-config svg,
  #rkroll-admin-root button.rkr-multi-delete svg { display: block; }
  /* Destructive — muted at rest like its neighbours; red only on
     hover/focus. Matches the admin posts-list and the cell-dialog
     delete (uniform trash treatment, --rkr-danger token). */
  #rkroll-admin-root button.rkr-multi-delete:hover,
  #rkroll-admin-root button.rkr-multi-delete:focus-visible {
    color: var(--rkr-danger); border-color: var(--rkr-danger); border-style: solid;
    background: color-mix(in srgb, var(--rkr-danger) 8%, transparent);
  }
  /* Browser-native :out-of-range styling for autoplay (input has
     min=0/max=60 attrs). Gives the author a visual cue that >60 will
     be silently clamped on save. */
  #rkr-figure-timer:out-of-range {
    border: 1px solid #c00;
    background: color-mix(in srgb, #c00 12%, var(--rkr-bg));
  }
  /* Image-edit pipeline section nested inside the figure-attrs grid;
     spans full width and stacks its own grid beneath. */
  #rkr-image-edit { grid-column: 1 / -1; display: contents; }
  #rkr-image-edit[hidden] { display: none; }
  /* Editor-side previews of figures: a labelled chip + a 3-col grid
     of thumbs. Single-image figures share the same grid (one cell in
     the first column); multi-image figures wrap across three columns
     into N rows. The grid is for *editor browsing only* — the public
     site honours the figure's declared matrix/justify/etc. */
  /* Two-column layout: label + thumbs grow in column 1; the action
     buttons (Add image / Configure) live in a narrow column 2 that
     spans every row so they stack vertically alongside the thumbs
     rather than below them. */
  #rkroll-admin-root .rkr-multi {
    display: grid;
    grid-template-columns: 1fr auto;
    column-gap: .5rem;
    margin: 1rem 0; padding: .5rem; border: 1px dashed var(--rkr-rule); border-radius: 4px;
    background: color-mix(in srgb, var(--rkr-text) 3%, var(--rkr-bg));
  }
  #rkroll-admin-root .rkr-multi > .rkr-multi-thumbs { grid-column: 1; }
  #rkroll-admin-root .rkr-multi > .rkr-multi-actions {
    grid-column: 2;
    grid-row: 1 / -1;
  }
  /* 3-col grid; rows grow with the tallest image, align-items:start
     keeps shorter images flush to the row top. */
  #rkroll-admin-root .rkr-multi-thumbs {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: .5rem;
    align-items: start;
  }
  /* Higher specificity than the generic img.rkr-image rule below so
     grid sizing wins. width:100% fills the 1fr cell; height:auto +
     no object-fit clamp keeps the natural aspect ratio. */
  /* min-height keeps the thumb clickable while async refreshImagePreview
     hasn't yet painted the local canvas blob URL — for tiny sources
     /admin/preview can return 422 (MIN_RENDER_DIM) and leave the img
     at 0px tall otherwise. */
  #rkroll-admin-root img.rkr-multi-thumb { width: 100%; height: auto; max-width: 100%; min-height: 8px; display: block; border-radius: 2px; cursor: pointer; margin: 0; }
  #rkroll-admin-root .rkr-multi-thumb.is-active-cell {
    outline: 2px solid var(--rkr-link, #1a4f7f);
    outline-offset: 2px;
  }
  #rkroll-admin-root .rkr-multi-caption {
    margin-top: .35rem; color: var(--rkr-muted); font-size: .85rem; font-style: italic;
  }
  /* Site.css's image positioning rules (rkr-pos-default, rkr-pos-full,
     rkr-pos-left, rkr-pos-right) target the public-page <figure> wrapper
     and assume the post is rendered inside the page's outer column. The
     editor's ImageNode emits a bare <img class="rkr-image rkr-pos-X">
     without that wrapper, so a user picking position=full would otherwise
     trigger width:100vw + negative-margin breakout that escapes the
     editor frame entirely. Clamp every editor image to the editable box;
     the actual breakout/float behavior takes effect only on the published
     page. Higher specificity than .rkr-pos-* so this wins without !important. */
  #rkroll-admin-root img.rkr-image {
    display: block;
    max-width: 100%;
    width: auto;
    height: auto;
    margin: .5rem 0;
  }
  /* Image-attribute action row + crop modal. flex-wrap so the dense
     icon-button cluster wraps onto a second row on narrow viewports
     instead of horizontally overflowing. */
  .rkr-image-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
  .rkr-image-actions button { padding: .25rem .75rem; cursor: pointer; }
  .rkr-image-actions button:disabled { opacity: .4; cursor: not-allowed; }
  /* Save edits is the primary action: visually distinct from the
     in-place ops (rotate/flip/etc) and the Reset escape hatch. The
     dirty-state flip lives in JS via the disabled attribute. */
  .rkr-image-actions button.rkr-image-save:not(:disabled) {
    background: var(--rkr-link); color: var(--rkr-bg);
    border: 1px solid var(--rkr-link);
  }
  /* Edits panel: ordered list of ops in click order, each with an
     inline delete button. Spans the value column of the parent grid
     so the label sits on its own row beside step 1. */
  #rkr-image-edits-label { align-self: start; padding-top: .25rem; color: var(--rkr-muted); }
  #rkr-image-edits {
    margin: 0; padding: 0; list-style: none;
    display: flex; flex-direction: column; gap: .15rem;
  }
  #rkr-image-edits:empty::before {
    content: 'no edits'; color: var(--rkr-muted); font-style: italic; font-size: .85rem;
  }
  #rkr-image-edits li {
    display: flex; align-items: center; gap: .5rem;
    font-family: ui-monospace, monospace; font-size: .85rem;
  }
  #rkr-image-edits .rkr-edits-step { flex: 1; }
  #rkr-image-edits button.rkr-edits-del {
    padding: 0 .35rem; background: transparent;
    border: 1px solid var(--rkr-rule); border-radius: 2px;
    cursor: pointer; font-size: .85rem; line-height: 1.4;
  }
  #rkr-image-edits button.rkr-edits-del:hover {
    background: color-mix(in srgb, var(--rkr-text) 8%, var(--rkr-bg));
  }
  #rkr-crop-modal {
    border: 1px solid var(--rkr-rule); border-radius: 6px; padding: 0;
    width: min(80vw, 60rem); max-width: 95vw; max-height: 90vh;
    background: var(--rkr-bg); color: var(--rkr-text);
    box-shadow: 0 8px 32px rgba(0,0,0,.4);
  }
  #rkr-crop-modal::backdrop { background: rgba(0,0,0,.6); }
  #rkr-crop-modal h2 {
    margin: 0; padding: .75rem 1rem;
    font-size: 1rem; font-family: system-ui, sans-serif;
    border-bottom: 1px solid var(--rkr-rule);
  }
  #rkr-crop-modal .rkr-crop-stage {
    /* Cropper needs a contained stage that bounds the image so the
       handles render inside the modal rather than at full image size. */
    height: 60vh; max-height: 32rem;
    background: color-mix(in srgb, var(--rkr-text) 90%, var(--rkr-bg));
  }
  #rkr-crop-modal .rkr-crop-stage img {
    /* Cropper.js requires display:block + width:100% to attach handles. */
    display: block; max-width: 100%;
  }
  #rkr-crop-modal .rkr-crop-actions {
    display: flex; gap: .5rem; align-items: center; padding: .75rem;
    border-top: 1px solid var(--rkr-rule); justify-content: flex-end;
  }
  #rkr-crop-modal #rkr-crop-status { flex: 1; color: var(--rkr-muted); font-size: .9rem; }
  #rkr-crop-modal button { padding: .35rem .85rem; cursor: pointer; }
  /* Perspective modal: same outer shell as the crop modal, but the
     stage is custom (no Cropper.js). 4 absolutely-positioned handles
     over the image, plus an SVG that draws the connecting quad. */
  #rkr-persp-modal {
    border: 1px solid var(--rkr-rule); border-radius: 6px; padding: 0;
    width: min(80vw, 60rem); max-width: 95vw; max-height: 90vh;
    background: var(--rkr-bg); color: var(--rkr-text);
    box-shadow: 0 8px 32px rgba(0,0,0,.4);
  }
  #rkr-persp-modal::backdrop { background: rgba(0,0,0,.6); }
  #rkr-persp-modal h2 {
    margin: 0; padding: .75rem 1rem; font-size: 1rem;
    font-family: system-ui, sans-serif;
    border-bottom: 1px solid var(--rkr-rule);
  }
  #rkr-persp-modal .rkr-persp-stage {
    position: relative; height: 60vh; max-height: 32rem;
    background: color-mix(in srgb, var(--rkr-text) 90%, var(--rkr-bg));
    overflow: hidden;
  }
  #rkr-persp-modal .rkr-persp-stage img {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    max-width: 100%; max-height: 100%;
    user-select: none; pointer-events: none;
  }
  #rkr-persp-modal .rkr-persp-stage svg {
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    pointer-events: none;
  }
  #rkr-persp-modal .rkr-persp-handle {
    position: absolute; width: 1.25rem; height: 1.25rem;
    margin: -.625rem 0 0 -.625rem;
    background: var(--rkr-link); border: 2px solid var(--rkr-bg);
    border-radius: 50%; cursor: grab;
    box-shadow: 0 0 0 1px var(--rkr-rule);
    touch-action: none;
  }
  #rkr-persp-modal .rkr-persp-handle:active { cursor: grabbing; }
  #rkr-persp-modal .rkr-persp-actions {
    display: flex; gap: .5rem; align-items: center; padding: .75rem;
    border-top: 1px solid var(--rkr-rule); justify-content: flex-end;
  }
  #rkr-persp-modal #rkr-persp-status { flex: 1; color: var(--rkr-muted); font-size: .9rem; }
  #rkr-persp-modal button { padding: .35rem .85rem; cursor: pointer; }
  /* OneDrive file browser modal */
  #rkr-onedrive-browser {
    border: 1px solid var(--rkr-rule); border-radius: 6px; padding: 0;
    width: min(80vw, 56rem); max-width: 95vw; height: min(80vh, 42rem);
    background: var(--rkr-bg); color: var(--rkr-text);
    box-shadow: 0 8px 32px rgba(0,0,0,.4);
    display: flex; flex-direction: column; overflow: hidden;
  }
  #rkr-onedrive-browser::backdrop { background: rgba(0,0,0,.6); }
  .rkr-od-head {
    padding: .75rem 1rem; border-bottom: 1px solid var(--rkr-rule);
    display: flex; align-items: baseline; gap: .75rem; flex-shrink: 0; flex-wrap: wrap;
  }
  .rkr-od-title { font-weight: 600; font-size: 1rem; white-space: nowrap; }
  .rkr-od-breadcrumb { display: flex; align-items: center; font-size: .875rem; flex-wrap: wrap; }
  .rkr-od-crumb-btn {
    background: none; border: none; color: var(--rkr-link); cursor: pointer;
    padding: 0 .15rem; font: inherit; font-size: .875rem;
  }
  .rkr-od-crumb { color: var(--rkr-muted); padding: 0 .15rem; }
  .rkr-od-sep { color: var(--rkr-muted); }
  .rkr-od-grid {
    flex: 1; min-height: 0; overflow-y: auto; padding: .75rem;
    display: grid; grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr));
    gap: .5rem; align-content: start;
  }
  .rkr-od-item {
    display: flex; flex-direction: column; align-items: center; gap: .3rem;
    padding: .4rem; border: 1px solid var(--rkr-rule); border-radius: 4px;
    background: none; cursor: pointer; min-width: 0;
    transition: background-color .1s ease-out, border-color .1s ease-out;
  }
  .rkr-od-item:hover:not(:disabled) {
    background: color-mix(in srgb, var(--rkr-link) 10%, transparent);
    border-color: var(--rkr-link);
  }
  .rkr-od-item.rkr-od-selected {
    background: color-mix(in srgb, var(--rkr-link) 18%, transparent);
    border-color: var(--rkr-link);
    box-shadow: 0 0 0 2px var(--rkr-link);
  }
  .rkr-od-item:disabled { opacity: .45; cursor: default; }
  .rkr-od-thumb {
    width: 100%; aspect-ratio: 1; display: flex; align-items: center;
    justify-content: center; overflow: hidden; border-radius: 3px;
  }
  .rkr-od-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .rkr-od-folder .rkr-od-thumb { color: var(--rkr-link); }
  .rkr-od-file .rkr-od-thumb svg { color: var(--rkr-muted); }
  .rkr-od-name {
    font-size: .7rem; line-height: 1.3; color: var(--rkr-text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
  }
  .rkr-od-placeholder {
    grid-column: 1/-1; padding: 3rem 1rem;
    text-align: center; color: var(--rkr-muted); font-size: .9rem;
  }
  .rkr-od-placeholder.rkr-od-error {
    color: var(--rkr-warn, #c00); user-select: text; -webkit-user-select: text;
  }
  .rkr-od-foot {
    padding: .65rem 1rem; border-top: 1px solid var(--rkr-rule);
    display: flex; align-items: center; gap: .75rem; flex-shrink: 0;
  }
  .rkr-od-status {
    flex: 1; color: var(--rkr-muted); font-size: .85rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .rkr-od-cancel { padding: .35rem .85rem; cursor: pointer; }
  .rkr-od-import {
    padding: .35rem .85rem; cursor: pointer;
    background: var(--rkr-link); color: var(--rkr-bg);
    border: 1px solid var(--rkr-link); border-radius: 4px; font-weight: 600;
  }
  .rkr-od-import:hover:not(:disabled) { background: var(--rkr-link-hover); border-color: var(--rkr-link-hover); }
  .rkr-od-import:disabled { opacity: .5; cursor: default; }
`;
