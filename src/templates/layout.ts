// Shared site chrome: header + footer used by both /:slug and / templates.
// Driven by SITE_TITLE / SITE_TAGLINE env vars (lib/config.ts).

import { escapeAttr, escapeText } from '../lib/content.ts';

export interface SiteChrome {
  /** Resolved site config — owner-side branding only; never per-request. */
  site: { title: string; tagline?: string };
}

export function siteHead(site: SiteChrome['site']): string {
  const tagline = site.tagline
    ? `<span class="rkr-site-tagline">${escapeText(site.tagline)}</span>`
    : '';
  return `<header class="rkr-site-head">
  <div class="rkr-site-head-inner">
    <h1 class="rkr-site-title"><a href="/">${escapeText(site.title)}</a></h1>
    ${tagline}
  </div>
</header>`;
}

export function siteFoot(site: SiteChrome['site']): string {
  const year = new Date().getFullYear();
  return `<footer class="rkr-site-foot">
  &copy; ${year} ${escapeAttr(site.title)}
</footer>`;
}
