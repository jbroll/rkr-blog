// Shell page for the JSON blocks editor (experimental). Server renders
// the chrome plus an empty mount point; the bundled editor module
// fetches the page tree and macro list and owns the DOM from there.

import { escapeAttr, escapeText } from '../lib/content.ts';
import {
  bundleVersion,
  headIcons,
  type SiteChrome,
  siteFoot,
  siteHead,
  stylesheetLinks
} from './layout.ts';

export interface BlocksEditPageData extends SiteChrome {
  slug: string;
  isAdmin?: boolean;
}

export function renderBlocksEditPage(data: BlocksEditPageData): string {
  const a = data.assets;
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
<div id="rkr-blocks-edit-root" data-slug="${escapeAttr(data.slug)}"></div>
</main>
${siteFoot(data.site, { isAdmin: data.isAdmin })}
<script type="module" src="${a.base}/admin/blocks-page-editor-entry.js${bundleVersion(a)}"></script>
</body>
</html>
`;
}
