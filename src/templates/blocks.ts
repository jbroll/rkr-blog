import { escapeAttr, escapeText } from '../lib/content.ts';
import { icon } from './icons.ts';
import {
  adminPwaHead,
  bundleVersion,
  footerOpt,
  headIcons,
  type SiteChrome,
  siteFoot,
  siteHead,
  stylesheetLinks
} from './layout.ts';
import { buildMetaTag } from './version-tag.ts';

export interface BlocksPageData extends SiteChrome {
  title: string;
  /** Page slug for the edit affordance. Omitted for macro demos,
   * which have no stored page to edit. */
  slug?: string;
  bodyHtml: string;
  isAdmin?: boolean;
  /** Extra CSS appended to the head (admin list pages). */
  css?: string;
  /** Admin pages served in the admin scope register its service worker. */
  adminPwa?: boolean;
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
${buildMetaTag(a.hash)}
${data.adminPwa ? adminPwaHead(a) : ''}
${data.css ? `<style>${data.css}</style>` : ''}
</head>
<body>
${siteHead(data.site, { isAdmin: data.isAdmin, buildHash: a.hash, assets: a, ...(data.chrome ? { chrome: data.chrome } : {}) })}
<main id="main" tabindex="-1">
${data.bodyHtml}</main>
${data.isAdmin && data.slug ? blocksAdminFab(data.slug) : ''}
${siteFoot(data.site, { isAdmin: data.isAdmin, ...footerOpt(data.chrome) })}
<script type="module" src="${a.base}/site/carousel.js${bundleVersion(a)}" defer></script>
<script type="module" src="${a.base}/site/version-check.js${bundleVersion(a)}" defer></script>
</body>
</html>
`;
}
