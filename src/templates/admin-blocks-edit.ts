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
import {
  adminPwaHead,
  headIcons,
  type SiteChrome,
  siteFoot,
  siteHead,
  stylesheetLinks
} from './layout.ts';
import { buildMetaTag } from './version-tag.ts';

export interface BlocksEditPageData extends SiteChrome {
  slug: string;
  /** Stored file version; the editor sends it back as `baseVersion`. */
  version?: string;
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
  /** Section theme names for the grid dialog. */
  sectionThemes?: string[];
}

/** Make JSON safe inside a `<script type="application/json">` block:
 * `\u003c` keeps `</script>` and `<!--` out of the raw text without
 * changing the parsed value. */
function scriptSafeJson(json: string): string {
  return json.replace(/</g, '\\u003c');
}

const tool = (id: string, label: string, extra = ''): string =>
  `<button type="button" class="rkr-edit-btn rkr-image-tool" id="${id}"${extra}>${label}</button>`;

/** Media pipeline markup the editor bundle wires once: the image editor
 * the figure dialog borrows (stashed in a hidden host), the source
 * picker, the crop and straighten modals, and the file inputs. */
const MEDIA_MARKUP = `<div id="rkr-image-edit-host" hidden>
<div id="rkr-image-edit" hidden>
<div class="rkr-image-tools" role="group" aria-label="Image tools">
${tool('rkr-image-rotate-l-btn', 'Rotate left')}
${tool('rkr-image-rotate-r-btn', 'Rotate right')}
${tool('rkr-image-flip-h-btn', 'Flip horizontal')}
${tool('rkr-image-flip-v-btn', 'Flip vertical')}
${tool('rkr-image-crop-btn', 'Crop')}
${tool('rkr-image-perspective-btn', 'Straighten')}
${tool('rkr-image-undo-btn', 'Undo', ' disabled')}
${tool('rkr-image-redo-btn', 'Redo', ' disabled')}
${tool('rkr-image-reset-btn', 'Reset', ' hidden')}
</div>
<img id="rkr-cell-preview" class="rkr-image-preview" alt="Preview of the edited image" hidden/>
<div class="rkr-image-adjust">
<div class="rkr-field"><label for="rkr-image-tilt-input">Tilt (degrees)</label>
<div class="rkr-image-inline"><input id="rkr-image-tilt-slider" type="range" min="-45" max="45" step="0.1" value="0" aria-label="Tilt"/><input id="rkr-image-tilt-input" type="number" min="-45" max="45" step="0.1" value="0"/>${tool('rkr-image-tilt-btn', 'Apply tilt')}</div></div>
<div class="rkr-field"><label for="rkr-image-resample">Max width (px)</label>
<div class="rkr-image-inline"><input id="rkr-image-resample" type="number" min="0" max="8000" step="50" placeholder="No limit"/>${tool('rkr-image-resample-btn', 'Apply width')}</div></div>
</div>
<details class="rkr-image-steps"><summary>Edit steps</summary><ol id="rkr-image-edits" aria-label="Edit steps in order"></ol></details>
</div>
</div>
<dialog id="rkr-source-picker" class="rkr-dialog rkr-source-dialog" data-rkr-dialog aria-labelledby="rkr-source-picker-title">
<div class="rkr-dialog-head"><h2 id="rkr-source-picker-title" class="rkr-dialog-title">Add image</h2></div>
<div class="rkr-dialog-body rkr-source-actions">
<button type="button" class="rkr-edit-btn" data-source="local">From this computer</button>
<button type="button" class="rkr-edit-btn" data-source="drive">From Google Drive</button>
<button type="button" class="rkr-edit-btn" data-source="photos">From Google Photos</button>
<button type="button" class="rkr-edit-btn" data-source="onedrive">From OneDrive</button>
</div>
<div class="rkr-dialog-foot"><button type="button" class="rkr-edit-btn is-quiet" data-source="">Cancel</button></div>
</dialog>
<dialog id="rkr-crop-modal" data-rkr-dialog aria-labelledby="rkr-crop-modal-title">
<h2 id="rkr-crop-modal-title">Crop image</h2>
<div class="rkr-crop-stage"><img id="rkr-crop-img" alt=""/></div>
<div class="rkr-crop-actions"><span id="rkr-crop-status"></span>
<button type="button" class="rkr-edit-btn is-quiet" id="rkr-crop-cancel">Cancel</button>
<button type="button" class="rkr-edit-btn is-primary" id="rkr-crop-save">Crop</button></div>
</dialog>
<dialog id="rkr-persp-modal" data-rkr-dialog aria-labelledby="rkr-persp-modal-title">
<h2 id="rkr-persp-modal-title">Straighten</h2>
<div class="rkr-persp-stage" id="rkr-persp-stage"><img id="rkr-persp-img" alt=""/><svg id="rkr-persp-svg" xmlns="http://www.w3.org/2000/svg"></svg></div>
<div class="rkr-persp-actions"><span id="rkr-persp-status">Drag the four handles to the corners of the area to straighten</span>
<button type="button" class="rkr-edit-btn is-quiet" id="rkr-persp-cancel">Cancel</button>
<button type="button" class="rkr-edit-btn is-primary" id="rkr-persp-save">Straighten</button></div>
</dialog>
<input id="rkr-image-input" type="file" accept="image/*" multiple hidden/>
<input id="rkr-video-input" type="file" accept="video/*" hidden/>`;

export function renderBlocksEditPage(data: BlocksEditPageData): string {
  const a = data.assets;
  const treeScript = data.treeJson
    ? `\n<script type="application/json" id="rkr-tree">${scriptSafeJson(data.treeJson)}</script>`
    : '';
  const themesAttr = data.sectionThemes
    ? ` data-section-themes="${escapeAttr(JSON.stringify(data.sectionThemes))}"`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Edit ${escapeText(data.slug)} — ${escapeText(data.site.title)}</title>
${stylesheetLinks(a)}
${headIcons(a)}
${buildMetaTag(a.hash)}
${adminPwaHead(a)}
<style>${ADMIN_CSS_CORE}</style>
<style>${ADMIN_CSS_DIALOGS}</style>
<link rel="stylesheet" href="${escapeAttr(data.bundleUrl.replace(/\.js(?=\?|$)/, '.css'))}"/>
<style>${EDITOR_CSS}</style>
</head>
<body>
${siteHead(data.site, { isAdmin: data.isAdmin, assets: a })}
<main id="main" tabindex="-1">
<div id="rkroll-admin-status" role="status" aria-live="polite"></div>
<div id="rkr-blocks-edit-root" data-slug="${escapeAttr(data.slug)}"${data.version ? ` data-version="${escapeAttr(data.version)}"` : ''}${themesAttr}>${treeScript}
<div id="rkr-unified-shell" class="rkr-unified-shell is-view" data-mode="view">
<div id="rkr-unified-toolbar" class="rkr-unified-toolbar">
<span class="rkr-unified-title">${escapeText(data.title || data.slug)}</span>
<div class="rkr-unified-modes" role="group" aria-label="Editor mode">
<button type="button" class="rkr-unified-mode" data-mode="view" aria-pressed="true">View</button>
<button type="button" class="rkr-unified-mode" data-mode="edit" aria-pressed="false">Edit</button>
</div>
<button type="button" class="rkr-unified-preview rkr-edit-btn is-quiet" aria-pressed="false">Phone preview</button>
<button type="button" class="rkr-unified-settings rkr-edit-btn">Page settings</button>
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
${MEDIA_MARKUP}
<script type="module" src="${data.bundleUrl}"></script>
</body>
</html>
`;
}
