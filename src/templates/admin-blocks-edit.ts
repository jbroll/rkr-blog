// Shell page for the JSON blocks editor (experimental). Server renders
// the chrome plus the saved tree as the public page body (with
// invisible path markers) and the canonical tree JSON, so the bundled
// editor module hydrates the DOM in place instead of fetching and
// re-rendering. When no body/tree is supplied (e.g. a newly created
// page) the mount point is simply empty.

import { escapeAttr, escapeText } from '../lib/content.ts';
import { EDITOR_CSS } from './admin-editor-styles.ts';
import { ADMIN_CSS_CORE } from './admin-styles-core.ts';
import { ADMIN_CSS_DIALOGS } from './admin-styles-dialogs.ts';
import { headIcons, type SiteChrome, siteFoot, siteHead, stylesheetLinks } from './layout.ts';

export interface BlocksEditPageData extends SiteChrome {
  slug: string;
  /** Page title shown in the toolbar; falls back to the slug. */
  title?: string;
  /** Full versioned URL of the editor bundle (admin static scope). */
  bundleUrl: string;
  isAdmin?: boolean;
  /** The saved tree rendered as the public page body, carrying
   * invisible `<!--rkr:path=…-->` markers for the client to hydrate. */
  bodyHtml?: string;
  /** Canonical tree JSON, embedded for client hydration. Escaped here
   * so a markdown slot can never close the script element. */
  treeJson?: string;
}

/** Make JSON safe inside a `<script type="application/json">` block:
 * `\u003c` keeps `</script>` and `<!--` out of the raw text without
 * changing the parsed value. */
function scriptSafeJson(json: string): string {
  return json.replace(/</g, '\\u003c');
}

export function renderBlocksEditPage(data: BlocksEditPageData): string {
  const a = data.assets;
  const treeScript = data.treeJson
    ? `\n<script type="application/json" id="rkr-tree">${scriptSafeJson(data.treeJson)}</script>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Edit ${escapeText(data.slug)} — ${escapeText(data.site.title)}</title>
${stylesheetLinks(a)}
${headIcons(a)}
<style>${ADMIN_CSS_CORE}</style>
<style>${ADMIN_CSS_DIALOGS}</style>
<style>${EDITOR_CSS}</style>
</head>
<body>
${siteHead(data.site, { isAdmin: data.isAdmin })}
<main id="main" tabindex="-1">
<div id="rkroll-admin-status" role="status" aria-live="polite"></div>
<div id="rkr-blocks-edit-root" data-slug="${escapeAttr(data.slug)}">${treeScript}
<div id="rkr-unified-shell" class="rkr-unified-shell is-view" data-mode="view">
<div id="rkr-unified-toolbar" class="rkr-unified-toolbar">
<span class="rkr-unified-title">${escapeText(data.title || data.slug)}</span>
<div class="rkr-unified-modes" role="group" aria-label="Editor mode">
<button type="button" class="rkr-unified-mode" data-mode="view" aria-pressed="true">View</button>
<button type="button" class="rkr-unified-mode" data-mode="edit" aria-pressed="false">Edit</button>
</div>
<span class="rkr-unified-save-state" aria-live="polite">Saved</span>
<button type="button" class="rkr-unified-save rkr-edit-btn is-primary" disabled>Save</button>
</div>
<div class="rkr-unified-layout">
<div id="rkr-blocks-page-body" class="rkr-blocks-page-body">
${data.bodyHtml ?? ''}</div>
<aside id="rkr-unified-dock" class="rkr-blocks-palette-right" aria-label="Blocks palette" hidden></aside>
</div>
</div>
</div>
</main>
${siteFoot(data.site, { isAdmin: data.isAdmin })}
<!-- Image-edit pipeline elements (used by the figure dialog). -->
<div id="rkr-image-edit-host" hidden>
  <div id="rkr-image-edit">
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
      <button type="button" id="rkr-image-save-btn" class="rkr-image-save" aria-label="Save edits to this image" title="Commit ops + upload bake to the server" disabled>Save</button>
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
    <img id="rkr-cell-preview" class="rkr-cell-preview" alt="" hidden/>
  </div>
</div>
<script type="module" src="${data.bundleUrl}"></script>
</body>
</html>
`;
}
