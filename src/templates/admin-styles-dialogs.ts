// Admin SPA stylesheet — meta grid, figure/cell config dialogs,
// image-edit pipeline, crop / perspective / OneDrive modals. Split
// from the original admin-styles.ts (with admin-styles-core.ts) so
// each module stays under the 500-line size cap. Concatenated
// AFTER ADMIN_CSS_CORE by admin.ts (join with a single newline) so
// the emitted CSS is character-identical to the pre-split string —
// CSS is order-sensitive, do not reorder relative to the core file.

export const ADMIN_CSS_DIALOGS = `  .rkr-meta { display: grid; grid-template-columns: max-content 1fr; gap: .5rem 1rem; margin-bottom: 1rem; align-items: center; }
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
