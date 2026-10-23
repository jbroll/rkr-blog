// New JSON page form (experimental blocks editor). One field — the
// slug — then straight into the tree editor.

import { escapeText } from '../lib/content.ts';
import { headIcons, type SiteChrome, siteFoot, siteHead, stylesheetLinks } from './layout.ts';

export interface BlocksNewPageData extends SiteChrome {
  isAdmin?: boolean;
}

export function renderBlocksNewPage(data: BlocksNewPageData): string {
  const a = data.assets;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>New page — ${escapeText(data.site.title)}</title>
${stylesheetLinks(a)}
${headIcons(a)}
</head>
<body>
${siteHead(data.site, { isAdmin: data.isAdmin })}
<main id="main" tabindex="-1">
<h1>New page</h1>
<form method="post" action="/admin/blocks/new">
<label for="rkr-new-slug">Slug</label>
<input id="rkr-new-slug" name="slug" type="text" required maxlength="100" pattern="[a-z0-9-]+" placeholder="my-new-page"/>
<button type="submit">Create and edit</button>
</form>
</main>
${siteFoot(data.site, { isAdmin: data.isAdmin })}
</body>
</html>
`;
}
