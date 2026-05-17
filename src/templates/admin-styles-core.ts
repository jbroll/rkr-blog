// Admin SPA stylesheet — core layout, toolbar, editor frame, sync
// badge, and storage panel. Split from the original admin-styles.ts
// (with admin-styles-dialogs.ts) so each module stays under the
// 500-line size cap; the rules here are scoped under
// #rkroll-admin-root / its sibling overlays. Concatenated with
// ADMIN_CSS_DIALOGS by admin.ts in the original rule order — CSS is
// order-sensitive, do not reorder relative to that file.

export const ADMIN_CSS_CORE = `
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
    width: 6px;
    margin-left: -3px;
    background: #00e000;
    border-radius: 3px;
    /* Thick dual ring — light inner + dark outer — so the bright-green
       bar keeps contrast on both white and dark editor backgrounds,
       plus a green glow. */
    box-shadow:
      0 0 0 2px rgba(255, 255, 255, .95),
      0 0 0 5px rgba(0, 0, 0, .6),
      0 0 10px #00e000;
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
  #rkr-storage-schema { color: var(--rkr-muted); font-size: .8rem; margin-top: 1rem; text-align: right; }`;
