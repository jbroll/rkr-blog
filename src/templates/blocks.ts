import { escapeAttr, escapeText } from '../lib/content.ts';
import { icon } from './icons.ts';
import {
  bundleVersion,
  headIcons,
  type SiteChrome,
  siteFoot,
  siteHead,
  stylesheetLinks
} from './layout.ts';

export interface BlocksPageData extends SiteChrome {
  title: string;
  /** Page slug for the edit affordance. Omitted for macro demos,
   * which have no stored page to edit. */
  slug?: string;
  bodyHtml: string;
  isAdmin?: boolean;
}

/** Index of stored JSON pages: title links in slug order. */
export function renderBlocksIndex(pages: { slug: string; title: string }[]): string {
  const items = pages
    .map((p) => `<li><a href="/pages/${escapeAttr(p.slug)}">${escapeText(p.title)}</a></li>`)
    .join('\n');
  return `<ul class="post-list">\n${items}\n</ul>\n`;
}

/** Pencil button into the JSON editor, mirroring postAdminFab for
 * markdown posts. Rendered only for signed-in admins on stored pages. */
function blocksAdminFab(slug: string): string {
  const href = `/admin/blocks/edit/${encodeURIComponent(slug)}`;
  return `<a class="rkr-fab rkr-fab--slot-1" href="${escapeAttr(href)}" aria-label="Edit this page" title="Edit this page">
  ${icon('pencil', 22)}
</a>`;
}

/** Public chrome around one rendered macro. The body is trusted
 * renderer output; the title is escaped. */
export function renderBlocksPage(data: BlocksPageData): string {
  const a = data.assets;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeText(data.title)} — ${escapeText(data.site.title)}</title>
${stylesheetLinks(a)}
${headIcons(a)}
</head>
<body>
${siteHead(data.site, { isAdmin: data.isAdmin })}
<main id="main" tabindex="-1">
${data.bodyHtml}</main>
${data.isAdmin && data.slug ? blocksAdminFab(data.slug) : ''}
${siteFoot(data.site, { isAdmin: data.isAdmin })}
<script type="module" src="${a.base}/site/carousel.js${bundleVersion(a)}" defer></script>
</body>
</html>
`;
}
