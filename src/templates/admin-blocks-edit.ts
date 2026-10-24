// Shell page for the JSON blocks editor (experimental). Server renders
// the chrome plus the saved tree as the public page body (with
// invisible path markers) and the canonical tree JSON, so the bundled
// editor module hydrates the DOM in place instead of fetching and
// re-rendering. When no body/tree is supplied (e.g. a newly created
// page) the mount point is simply empty.

import { escapeAttr, escapeText } from '../lib/content.ts';
import { headIcons, type SiteChrome, siteFoot, siteHead, stylesheetLinks } from './layout.ts';

export interface BlocksEditPageData extends SiteChrome {
  slug: string;
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

/** Shell-only stylesheet (the edit page's CSP allows inline styles).
 * View mode must show the public page: the palette dock is hidden and
 * the page body is never wrapped or restyled. In edit mode the dock
 * slides in on the right and config buttons appear on hover/focus. */
const UNIFIED_CSS = `
.rkr-unified-toolbar{display:flex;align-items:center;gap:.5rem;margin:0 0 1rem;font:inherit}
.rkr-unified-modes{display:inline-flex;border:1px solid var(--rkr-rule);border-radius:999px;overflow:hidden}
.rkr-unified-mode{border:0;background:transparent;color:inherit;padding:.35rem .9rem;font:inherit;cursor:pointer}
.rkr-unified-mode[aria-pressed="true"]{background:var(--rkr-link);color:var(--rkr-bg)}
.rkr-unified-layout{display:grid;gap:1.5rem;grid-template-columns:minmax(0,1fr)}
.rkr-unified-shell[data-mode="edit"] .rkr-unified-layout{grid-template-columns:minmax(0,1fr) 16rem}
.rkr-blocks-palette-right{position:sticky;top:1rem;align-self:start;max-height:calc(100vh - 2rem);overflow:auto;border-left:1px solid var(--rkr-rule);padding-left:1rem}
.rkr-unified-shell[data-mode="view"] .rkr-blocks-palette-right{display:none}
.rkr-unified-shell[data-mode="edit"] [data-rkr-path]:hover{outline:1px dashed var(--rkr-rule);outline-offset:4px}
.rkr-unified-node-tools{display:flex;justify-content:flex-end;opacity:0}
[data-rkr-path]:hover + .rkr-unified-node-tools,[data-rkr-path]:focus-within + .rkr-unified-node-tools,.rkr-unified-node-tools:focus-within{opacity:1}
.rkr-unified-config{border:1px solid var(--rkr-rule);background:var(--rkr-bg);color:inherit;border-radius:999px;padding:.15rem .6rem;font:inherit;font-size:.8rem;cursor:pointer}
@media (max-width:720px){.rkr-unified-shell[data-mode="edit"] .rkr-unified-layout{grid-template-columns:minmax(0,1fr)}}
`;

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
<style>${UNIFIED_CSS}</style>
</head>
<body>
${siteHead(data.site, { isAdmin: data.isAdmin })}
<main id="main" tabindex="-1">
<h1>Edit ${escapeText(data.slug)}</h1>
<div id="rkr-blocks-edit-root" data-slug="${escapeAttr(data.slug)}">${treeScript}
<div id="rkr-unified-shell" class="rkr-unified-shell is-view" data-mode="view">
<div id="rkr-unified-toolbar" class="rkr-unified-toolbar">
<div class="rkr-unified-modes" role="group" aria-label="Editor mode">
<button type="button" class="rkr-unified-mode" data-mode="view" aria-pressed="true">View</button>
<button type="button" class="rkr-unified-mode" data-mode="edit" aria-pressed="false">Edit</button>
</div>
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
<script type="module" src="${data.bundleUrl}"></script>
</body>
</html>
`;
}
