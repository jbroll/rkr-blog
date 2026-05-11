// Admin SPA shell.
//
// TipTap and ProseMirror are bundled into the admin entry by esbuild
// (see `npm run build:admin`); the served bundle has no third-party
// network dependency at runtime, which keeps the editor's CSP tight
// (script-src 'self' only, no esm.sh / CDN allowance).

export interface AdminPageData {
  /** Where the compiled admin bundle is mounted on the URL space. */
  bundleUrl: string;
}

export function renderAdminPage(data: AdminPageData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>rkroll admin</title>
<!-- Public theme: gives the editor preview the same look the published post
     will have (figures, prose width, headings, gallery/carousel placeholders).
     Loaded BEFORE the admin overrides so the inline styles below win for
     admin chrome (toolbar, panels, body layout). -->
<link rel="stylesheet" href="/static/site.css"/>
<!-- Cropper.js styles (extracted from the admin bundle by esbuild). -->
<link rel="stylesheet" href="/static/admin/main.css"/>
<style>
  /* Override site.css's body reset so the admin chrome keeps its own
     layout. The editor's prose preview lives inside <article> below,
     where site.css's prose rules apply naturally. */
  body {
    max-width: 56rem;
    margin: 2rem auto;
    padding: 0 1rem;
    background: var(--rkr-bg, #fff);
    color: var(--rkr-text, #1a1a1a);
  }
  /* Single font-family rule for all admin chrome (toolbar buttons,
     status, meta, panels). Site.css would otherwise impose its serif
     prose font on form controls, which is jarring for UI elements.
     The editable region inside <article> still gets the prose font. */
  body, button, input, select { font-family: system-ui, sans-serif; }
  /* Back-to-site link pinned to the top-left of the viewport so it
     takes no layout space (the editor body packs many controls and
     pushing things down even a line can drive the live preview below
     the fold on test viewports). */
  .rkr-admin-toplink {
    position: fixed; top: .5rem; left: .75rem;
    margin: 0; font-size: .85rem; z-index: 10;
  }
  .rkr-admin-toplink a { color: var(--rkr-muted); text-decoration: none; }
  .rkr-admin-toplink a:hover { color: var(--rkr-link); text-decoration: underline; }
  /* Admin chrome inherits site.css's --rkr-* tokens for borders / muted
     text / panel backgrounds so dark mode actually flips through. The
     fallbacks (after the comma) cover the case where site.css fails
     to load. */
  #rkroll-admin-toolbar { display: flex; gap: .25rem; flex-wrap: wrap; margin-bottom: 1rem; padding: .5rem; border: 1px solid var(--rkr-rule); border-radius: 4px; }
  #rkroll-admin-toolbar button { padding: .25rem .75rem; cursor: pointer; }
  #rkroll-admin-toolbar button.is-active { background: var(--rkr-text); color: var(--rkr-bg); }
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
  .rkr-sync-dot.is-verifying { background: #d4a72c; }
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
  /* Figure attribute panel: shown only when a figure node is selected.
     Use a translucent overlay over --rkr-bg so dark mode works without
     a separate color rule (color-mix maps to a slightly-darker neutral
     in dark mode, slightly-lighter in light mode). */
  #rkr-figure-attrs[hidden] { display: none; }
  #rkr-figure-attrs {
    display: grid; grid-template-columns: max-content 1fr; gap: .35rem .75rem;
    align-items: center; margin: .75rem 0;
    padding: .5rem .75rem; border: 1px solid var(--rkr-rule); border-radius: 4px;
    background: color-mix(in srgb, var(--rkr-text) 4%, var(--rkr-bg));
  }
  #rkr-figure-attrs h3 { grid-column: 1 / -1; margin: 0; font-size: .9rem; color: var(--rkr-muted); }
  #rkr-figure-attrs input, #rkr-figure-attrs select, #rkr-figure-attrs textarea { padding: .25rem; }
  /* Per-image alts textarea: monospace so column position matches the
     comma-separated wire format. */
  #rkr-figure-alts { font-family: ui-monospace, monospace; resize: vertical; max-height: 12rem; }
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
  /* Editor-side previews of multi-image directives: a labelled chip + a
     thumbnail strip, just enough that the author sees what's grouped. */
  #rkroll-admin-root .rkr-multi {
    margin: 1rem 0; padding: .5rem; border: 1px dashed var(--rkr-rule); border-radius: 4px;
    background: color-mix(in srgb, var(--rkr-text) 3%, var(--rkr-bg));
  }
  #rkroll-admin-root .rkr-multi-label {
    font-family: ui-monospace, monospace; font-size: .8rem; color: var(--rkr-muted); margin-bottom: .25rem;
    text-transform: uppercase; letter-spacing: .05em;
  }
  #rkroll-admin-root .rkr-multi-thumbs { display: flex; flex-wrap: wrap; gap: .35rem; }
  #rkroll-admin-root .rkr-multi-thumb {
    width: 6rem; height: 4rem; object-fit: cover; border-radius: 2px;
    cursor: pointer;
  }
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
</style>
</head>
<body>
<p class="rkr-admin-toplink"><a href="/" rel="nofollow">&larr; Back to site</a></p>
<h1 id="rkr-page-title">New post</h1>
<div class="rkr-meta">
  <label for="rkr-title">Title</label>   <input id="rkr-title" type="text"/>
  <label for="rkr-slug">Slug</label>     <input id="rkr-slug" type="text"/>
  <label for="rkr-status">Status</label>
  <select id="rkr-status">
    <option value="draft" selected>draft</option>
    <option value="published">published</option>
  </select>
</div>
<div id="rkroll-admin-toolbar"></div>
<div id="rkr-figure-attrs" hidden>
  <h3>Figure attributes</h3>
  <label for="rkr-figure-ids">IDs</label>
  <input id="rkr-figure-ids" type="text" readonly placeholder="comma-separated; populated by upload"/>
  <label for="rkr-figure-alts">Alt text</label>
  <textarea id="rkr-figure-alts" rows="3" placeholder="one alt per line, in id order; leave blank for decorative"></textarea>
  <label for="rkr-figure-caption">Caption</label>
  <input id="rkr-figure-caption" type="text" placeholder="optional caption shown below"/>
  <label for="rkr-figure-matrix">Matrix</label>
  <input id="rkr-figure-matrix" type="text" placeholder="e.g. 1x2, 1x3, justified, masonry, 1x1 (carousel)"/>
  <label for="rkr-figure-justify">Justify</label>
  <select id="rkr-figure-justify">
    <option value="center">center (default, breakout)</option>
    <option value="full">full (edge-to-edge)</option>
    <option value="bleed">bleed (full-width, no padding)</option>
    <option value="left">left (float, prose wraps right)</option>
    <option value="right">right (float, prose wraps left)</option>
    <option value="inline">inline (small, in text flow)</option>
  </select>
  <label for="rkr-figure-width">Width</label>
  <input id="rkr-figure-width" type="text" placeholder="e.g. 60%, 400px"/>
  <label for="rkr-figure-aspect">Aspect</label>
  <input id="rkr-figure-aspect" type="text" placeholder="e.g. 16:9 (empty: derive from first image)"/>
  <label for="rkr-figure-fit">Fit</label>
  <select id="rkr-figure-fit">
    <option value="cover">cover</option>
    <option value="contain">contain</option>
  </select>
  <label for="rkr-figure-timer">Autoplay (s)</label>
  <input id="rkr-figure-timer" type="number" min="0" max="60" step="1"/>
  <!-- Image-edit pipeline (crop / rotate / flip / perspective / resample
       + ops list). For single-image figures, main.ts reveals this
       section automatically (cell 0 is implicit). For multi-image
       figures, the user clicks a thumb to pick a cell and the section
       reveals scoped to that cell's id. -->
  <div id="rkr-image-edit" hidden>
    <span></span>
    <span class="rkr-image-actions">
      <button type="button" id="rkr-image-crop-btn">Crop…</button>
      <button type="button" id="rkr-image-rotate-l-btn" aria-label="Rotate 90 degrees counter-clockwise" title="Rotate 90° counter-clockwise">↺</button>
      <button type="button" id="rkr-image-rotate-r-btn" aria-label="Rotate 90 degrees clockwise" title="Rotate 90° clockwise">↻</button>
      <button type="button" id="rkr-image-flip-h-btn" aria-label="Flip horizontally" title="Flip horizontally">⇋</button>
      <button type="button" id="rkr-image-flip-v-btn" aria-label="Flip vertically" title="Flip vertically">⇕</button>
      <button type="button" id="rkr-image-perspective-btn" aria-label="Perspective rectify" title="Straighten a tilted region (de-skew)">⌐</button>
      <button type="button" id="rkr-image-undo-btn" aria-label="Undo last edit" title="Undo last edit" disabled>Undo</button>
      <button type="button" id="rkr-image-redo-btn" aria-label="Redo" title="Redo" disabled>Redo</button>
      <button type="button" id="rkr-image-reset-btn" hidden>Reset edits</button>
      <button type="button" id="rkr-image-save-btn" class="rkr-image-save" aria-label="Save edits to this image" title="Commit ops + upload bake to the server" disabled>Save edits</button>
    </span>
    <label for="rkr-image-resample">Max width (px)</label>
    <span class="rkr-image-actions">
      <input id="rkr-image-resample" type="number" min="0" max="8000" step="50" placeholder="leave blank for none"/>
      <button type="button" id="rkr-image-resample-btn">Apply</button>
    </span>
    <span id="rkr-image-edits-label">Edits</span>
    <ol id="rkr-image-edits" aria-label="Current edit pipeline (in order)"></ol>
  </div>
</div>
<dialog id="rkr-crop-modal" aria-labelledby="rkr-crop-modal-title">
  <h2 id="rkr-crop-modal-title">Crop image</h2>
  <div class="rkr-crop-stage">
    <img id="rkr-crop-img" alt=""/>
  </div>
  <div class="rkr-crop-actions">
    <span id="rkr-crop-status"></span>
    <button type="button" id="rkr-crop-cancel">Cancel</button>
    <button type="button" id="rkr-crop-save">Save crop</button>
  </div>
</dialog>
<dialog id="rkr-persp-modal" aria-labelledby="rkr-persp-modal-title">
  <h2 id="rkr-persp-modal-title">Perspective rectify</h2>
  <div class="rkr-persp-stage" id="rkr-persp-stage">
    <img id="rkr-persp-img" alt=""/>
    <svg id="rkr-persp-svg" xmlns="http://www.w3.org/2000/svg"></svg>
  </div>
  <div class="rkr-persp-actions">
    <span id="rkr-persp-status">Drag the four handles to the corners of the region to straighten</span>
    <button type="button" id="rkr-persp-cancel">Cancel</button>
    <button type="button" id="rkr-persp-save">Save perspective</button>
  </div>
</dialog>
<div id="rkroll-admin-root">
  <article id="rkroll-admin-article"></article>
  <button type="button" id="rkr-sync-badge" aria-label="Sync status (click for storage panel)">
    <span class="rkr-sync-dot" aria-hidden="true"></span>
    <span class="rkr-sync-text">verifying</span>
  </button>
</div>
<div id="rkroll-admin-status"></div>
<input id="rkr-image-input" type="file" accept="image/*" hidden/>
<script type="module" src="${data.bundleUrl}"></script>
</body>
</html>
`;
}
