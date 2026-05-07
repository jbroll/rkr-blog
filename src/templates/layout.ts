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
  // Skip-to-content link (visually hidden until focused) so keyboard
  // users can jump past the chrome on every page. Targets <main>, which
  // gets a matching id + tabindex via the post / index templates.
  // Site title is a <p>, not <h1> — post pages have their own <h1>
  // (the post title) and the index would otherwise have an h1 with
  // no document content underneath.
  return `<a class="rkr-skip" href="#main">Skip to content</a>
<header class="rkr-site-head">
  <div class="rkr-site-head-inner">
    <p class="rkr-site-title"><a href="/">${escapeText(site.title)}</a></p>
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
