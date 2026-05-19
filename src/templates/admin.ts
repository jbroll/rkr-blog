// Admin SPA shell.
//
// TipTap and ProseMirror are bundled into the admin entry by esbuild
// (see `npm run build:admin`); the served bundle has no third-party
// network dependency at runtime, which keeps the editor's CSP tight
// (script-src 'self' only, no esm.sh / CDN allowance).

import { escapeText } from '../lib/content.ts';
import { ADMIN_CSS_CORE } from './admin-styles-core.ts';
import { ADMIN_CSS_DIALOGS } from './admin-styles-dialogs.ts';
import { icon } from './icons.ts';
import { bundleVersion, headIcons, type SiteChrome, siteHead, stylesheetLinks } from './layout.ts';

export interface AdminPageData extends SiteChrome {
  /** Where the compiled admin bundle is mounted on the URL space. */
  bundleUrl: string;
  /**
   * Per-response CSP nonce. Stamped onto the inline <style> block so
   * the editor's CSP can drop script-src 'unsafe-inline' (the script
   * is an external self-hosted module; see routes/admin-csp.ts).
   */
  cspNonce: string;
}

export function renderAdminPage(data: AdminPageData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Editor — ${escapeText(data.site.title)}</title>
<!-- Public theme: gives the editor preview the same look the published post
     will have (figures, prose width, headings, gallery/carousel placeholders).
     Loaded BEFORE the admin overrides so the inline styles below win for
     admin chrome (toolbar, panels, body layout). -->
${stylesheetLinks()}
${headIcons()}
<!-- Cropper.js styles (extracted from the admin bundle by esbuild). -->
<link rel="stylesheet" href="/static/admin/main.css"/>
<style nonce="${data.cspNonce}">
${ADMIN_CSS_CORE}
${ADMIN_CSS_DIALOGS}
</style>
<link rel="manifest" href="/static/admin-manifest.webmanifest"/>
<script type="module" src="/static/site/sw-admin-register.js${bundleVersion()}" defer></script>
</head>
<body>
${siteHead(data.site, { isAdmin: true })}
<div class="rkr-admin-content">
<div class="rkr-page-title-row">
  <h1 id="rkr-page-title">New post</h1>
  <!-- View link to the post's permalink. Hidden until the post is
       saved (has a slug); page-title.ts toggles + sets href. -->
  <a id="rkr-page-view" class="rkr-page-view" href="" hidden>View →</a>
</div>
<div class="rkr-meta">
  <label for="rkr-title">Title</label>       <input id="rkr-title" type="text"/>
  <label for="rkr-subtitle">Subtitle</label> <input id="rkr-subtitle" type="text" placeholder="optional"/>
  <label for="rkr-tags">Tags</label>         <input id="rkr-tags" type="text" placeholder="travel, food, …" list="rkr-tags-list" autocomplete="off"/>
<datalist id="rkr-tags-list"></datalist>
  <label for="rkr-date">Date</label>         <input id="rkr-date" type="date"/>
  <!-- Slug is internal: the server derives it from the title on first
       save, and existing posts keep their loaded value. The admin
       doesn't see or edit it; a Copy-link button on the toolbar
       gives them the URL once the post has been saved. Status is
       likewise internal — it's edited per row on /admin/posts and the
       save handler preserves the existing status when the editor
       doesn't include one. -->
  <input id="rkr-slug" type="hidden"/>
</div>
<div id="rkroll-admin-toolbar"></div>
<!-- Image ids stay internal: the figure node carries them in its
     attrs and the save serialiser writes them into the ::figure
     directive. Keeping the input hidden (rather than removing it)
     lets the existing population path in main.ts keep working, and
     e2e tests can read it from any time the figure is selected
     without opening a dialog. -->
<input id="rkr-figure-ids" type="hidden"/>

<!-- Figure-level controls live in a modal dialog opened by the
     "Configure" button rendered inside each figure (figure-node.ts).
     Symmetric with the per-image dialog below. -->
<dialog id="rkr-figure-dialog" aria-labelledby="rkr-figure-dialog-title">
  <form method="dialog" class="rkr-cell-dialog-head">
    <h2 id="rkr-figure-dialog-title">Figure</h2>
    <button type="submit" class="rkr-cell-dialog-close" aria-label="Close">✕</button>
  </form>
  <div id="rkr-figure-attrs-figure" class="rkr-cell-dialog-body" data-scope="figure">
    <label for="rkr-figure-caption">Caption (block)</label>
    <input id="rkr-figure-caption" type="text" placeholder="optional caption shown below the figure"/>
    <span class="rkr-attr-label">Layout</span>
    <div id="rkr-figure-matrix" class="rkr-matrix-control">
      <div class="rkr-matrix-modes" role="radiogroup" aria-label="Layout mode">
        <label><input type="radio" name="rkr-matrix-mode" value="grid" checked/> Grid</label>
        <label><input type="radio" name="rkr-matrix-mode" value="justified"/> Justified</label>
        <label><input type="radio" name="rkr-matrix-mode" value="masonry"/> Masonry</label>
      </div>
      <div class="rkr-matrix-params" data-matrix-group="grid">
        <label for="rkr-matrix-rows">Rows</label>
        <input id="rkr-matrix-rows" type="number" min="1" max="12" step="1" value="1"/>
        <label for="rkr-matrix-cols">Cols</label>
        <input id="rkr-matrix-cols" type="number" min="1" max="12" step="1" value="1"/>
      </div>
      <div class="rkr-matrix-params" data-matrix-group="justified" hidden>
        <label for="rkr-matrix-height">Row height (px)</label>
        <input id="rkr-matrix-height" type="number" min="50" max="1000" step="10" value="180"/>
      </div>
      <div class="rkr-matrix-params" data-matrix-group="masonry" hidden>
        <label for="rkr-matrix-mcols">Cols</label>
        <input id="rkr-matrix-mcols" type="number" min="1" max="12" step="1" value="3"/>
      </div>
    </div>
    <label for="rkr-figure-justify">Position</label>
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
  </div>
</dialog>
<!-- Per-image properties live in a modal dialog opened on cell click;
     hosts the cell caption + alt and the full image-edit pipeline
     (crop / rotate / flip / perspective / resample + ops list). -->
<dialog id="rkr-cell-dialog" aria-labelledby="rkr-cell-dialog-title">
  <form method="dialog" class="rkr-cell-dialog-head">
    <h2 id="rkr-cell-dialog-title">Image</h2>
    <!-- Close is FIRST in DOM order so showModal's focusing steps
         land here (Enter on dialog open = close, harmless). Delete
         follows but is reordered visually to its left via flex
         order in admin-styles-dialogs, with extra gap so a stray tap on
         the X doesn't fire delete. Confirm + splice in main.ts. -->
    <button type="submit" class="rkr-cell-dialog-close" aria-label="Close">✕</button>
    <button type="button" id="rkr-cell-delete-btn" class="rkr-cell-delete" aria-label="Remove image from figure" title="Remove image from figure">${icon('trash2', 18)}</button>
  </form>
  <div id="rkr-figure-attrs-cell" class="rkr-cell-dialog-body" data-scope="cell">
    <label for="rkr-cell-caption">Caption</label>
    <input id="rkr-cell-caption" type="text" placeholder="caption for this image"/>
    <label for="rkr-cell-alt">Alt text</label>
    <input id="rkr-cell-alt" type="text" placeholder="alt for this image; blank if decorative"/>
    <p id="rkr-cell-hint" class="rkr-cell-hint" hidden>Click an image in the editor to edit it</p>
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
        <button type="button" id="rkr-image-save-btn" class="rkr-image-save" aria-label="Save edits to this image" title="Commit ops + upload bake to the server" disabled>${icon('save', 18)}</button>
      </span>
      <label for="rkr-image-resample">Max width (px)</label>
      <span class="rkr-image-actions">
        <input id="rkr-image-resample" type="number" min="0" max="8000" step="50" placeholder="leave blank for none"/>
        <button type="button" id="rkr-image-resample-btn">Apply</button>
      </span>
      <label for="rkr-image-tilt-input">Tilt (°)</label>
      <span class="rkr-image-actions">
        <input id="rkr-image-tilt-slider" type="range" min="-45" max="45" step="0.1" value="0" style="width:8em"/>
        <input id="rkr-image-tilt-input" type="number" min="-45" max="45" step="0.1" value="0" style="width:4em"/>
        <button type="button" id="rkr-image-tilt-btn">Apply</button>
      </span>
      <span id="rkr-image-edits-label">Edits</span>
      <ol id="rkr-image-edits" aria-label="Current edit pipeline (in order)"></ol>
      <!-- Live preview of the image with the current edits applied,
           kept in sync with the editor's <img> by the canvas pipeline
           (canvas-loaders → refreshImagePreview). Gives the author
           visual feedback inside the dialog so each rotate / crop /
           flip click shows up here without having to peek behind
           the modal. -->
      <img id="rkr-cell-preview" class="rkr-cell-preview" alt="" hidden/>
    </div>
  </div>
</dialog>
<dialog id="rkr-source-picker" aria-labelledby="rkr-source-picker-title">
  <h2 id="rkr-source-picker-title">Add image</h2>
  <div class="rkr-source-actions">
    <button type="button" data-source="local">From this computer…</button>
    <button type="button" data-source="drive">From Google Drive…</button>
    <button type="button" data-source="onedrive">From OneDrive…</button>
    <button type="button" data-source="">Cancel</button>
  </div>
</dialog>
<dialog id="rkr-crop-modal" aria-labelledby="rkr-crop-modal-title">
  <h2 id="rkr-crop-modal-title">Crop image</h2>
  <div class="rkr-crop-stage">
    <img id="rkr-crop-img" alt=""/>
  </div>
  <div class="rkr-crop-actions">
    <span id="rkr-crop-status"></span>
    <button type="button" id="rkr-crop-cancel">Cancel</button>
    <button type="button" id="rkr-crop-save" aria-label="Save crop" title="Save crop">${icon('save', 18)}</button>
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
    <button type="button" id="rkr-persp-save" aria-label="Save perspective" title="Save perspective">${icon('save', 18)}</button>
  </div>
</dialog>
<div id="rkroll-admin-root">
  <article id="rkroll-admin-article"></article>
  <button type="button" id="rkr-sync-badge" aria-label="Sync status (click for storage panel)">
    <span class="rkr-sync-dot" aria-hidden="true"></span>
    <span class="rkr-sync-text">online</span>
  </button>
</div>
<div id="rkroll-admin-status"></div>
<input id="rkr-image-input" type="file" accept="image/*" hidden/>
</div>
<script type="module" src="${data.bundleUrl}"></script>
</body>
</html>
`;
}
