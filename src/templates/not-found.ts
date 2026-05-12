// 404 page template. Plain template-literal HTML, same chrome as the
// index + post pages so the user lands on something themed rather than
// a bare `<h1>not found</h1>`.

import { escapeText } from '../lib/content.ts';
import { bundleVersion, type SiteChrome, siteFoot, siteHead, stylesheetLinks } from './layout.ts';

export interface NotFoundPageData extends SiteChrome {
  /** Authed visitors still see the admin footer affordances (Logout). */
  isAdmin?: boolean;
}

export function renderNotFoundPage(data: NotFoundPageData): string {
  const v = bundleVersion();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Not found — ${escapeText(data.site.title)}</title>
${stylesheetLinks()}
<link rel="manifest" href="/static/manifest.webmanifest"/>
<meta name="theme-color" content="#1a4f7f"/>
<script type="module" src="/static/site/sw-register.js${v}" defer></script>
</head>
<body>
${siteHead(data.site, { isAdmin: data.isAdmin })}
<main id="main" tabindex="-1" class="rkr-notfound">
<h1>Page not found</h1>
<p>The page you’re looking for isn’t here.</p>
<p><a href="/">← Back to ${escapeText(data.site.title)}</a></p>
</main>
${siteFoot(data.site, { isAdmin: data.isAdmin })}
</body>
</html>
`;
}
