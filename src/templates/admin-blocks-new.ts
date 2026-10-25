// New JSON page form: title and slug, then straight into the editor.
// new-page.js suggests the slug from the title as it is typed.

import { escapeAttr, escapeText } from '../lib/content.ts';
import {
  bundleVersion,
  headIcons,
  type SiteChrome,
  siteFoot,
  siteHead,
  stylesheetLinks
} from './layout.ts';

export interface BlocksNewPageData extends SiteChrome {
  isAdmin?: boolean;
  /** Values to refill after a rejected submit. */
  title?: string;
  slug?: string;
  error?: string;
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
<style>.rkr-new-page{display:grid;gap:.5rem;max-width:32rem}.rkr-new-page input{box-sizing:border-box;width:100%;font:inherit;padding:.4rem .6rem}.rkr-new-page p{margin:0;font-size:.875rem}.rkr-new-page button{justify-self:start;font:inherit;padding:.4rem 1rem}.rkr-form-error{color:#b3261e;max-width:32rem}</style>
</head>
<body>
${siteHead(data.site, { isAdmin: data.isAdmin })}
<main id="main" tabindex="-1">
<h1>New page</h1>
${data.error ? `<p class="rkr-form-error" role="alert">${escapeText(data.error)}</p>` : ''}
<form class="rkr-new-page" method="post" action="/admin/blocks/new">
<label for="rkr-new-title">Title</label>
<input id="rkr-new-title" name="title" type="text" required maxlength="200" value="${escapeAttr(data.title ?? '')}" autofocus/>
<label for="rkr-new-slug">Slug</label>
<input id="rkr-new-slug" name="slug" type="text" required maxlength="100" pattern="[a-z0-9\\-]+" value="${escapeAttr(data.slug ?? '')}" placeholder="my-new-page" aria-describedby="rkr-new-slug-hint"/>
<p id="rkr-new-slug-hint">Letters a-z, digits 0-9 and hyphens. It becomes the page address.</p>
<button type="submit">Create and edit</button>
</form>
</main>
${siteFoot(data.site, { isAdmin: data.isAdmin })}
<script type="module" src="${a.base}/admin/new-page.js${bundleVersion(a)}"></script>
</body>
</html>
`;
}
