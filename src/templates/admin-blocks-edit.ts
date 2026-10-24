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
</head>
<body>
${siteHead(data.site, { isAdmin: data.isAdmin })}
<main id="main" tabindex="-1">
<h1>Edit ${escapeText(data.slug)}</h1>
<div id="rkr-blocks-edit-root" data-slug="${escapeAttr(data.slug)}">${treeScript}
<div id="rkr-blocks-page-body" class="rkr-blocks-page-body">
${data.bodyHtml ?? ''}</div>
</div>
</main>
${siteFoot(data.site, { isAdmin: data.isAdmin })}
<script type="module" src="${data.bundleUrl}"></script>
</body>
</html>
`;
}
