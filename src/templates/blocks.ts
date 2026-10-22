import { escapeText } from '../lib/content.ts';
import {
  bundleVersion,
  headIcons,
  type SiteChrome,
  siteFoot,
  siteHead,
  stylesheetLinks,
} from './layout.ts';

export interface BlocksPageData extends SiteChrome {
  title: string;
  bodyHtml: string;
  isAdmin?: boolean;
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
${siteFoot(data.site, { isAdmin: data.isAdmin })}
<script type="module" src="${a.base}/site/carousel.js${bundleVersion(a)}" defer></script>
</body>
</html>
`;
}
