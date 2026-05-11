// Shared site chrome: header + footer used by both /:slug and / templates.
// Driven by SITE_TITLE / SITE_TAGLINE env vars (lib/config.ts).

import { resolveGitHash } from '../lib/build-info.ts';
import { themeName } from '../lib/config.ts';
import { escapeAttr, escapeText } from '../lib/content.ts';

/** ?v=<short-hash> suffix appended to public-side bundle / stylesheet
 * URLs so the service worker (src/site/sw.ts) treats each deploy as a
 * distinct cache key. When the git hash can't be resolved, the
 * fallback suffix is `?v=unknown` — consistent per-process, so the SW
 * still caches deterministically (the deploy can re-warm by setting
 * GIT_HASH env). */
export function bundleVersion(): string {
  return `?v=${resolveGitHash().slice(0, 12)}`;
}

/** `<link>` tags for the public-side stylesheets. base.css carries the
 * theme-invariant primitives (a11y, overflow-clip); the active theme
 * (default, or whatever SITE_THEME selects) follows so its values win
 * on the cascade. See docs/theming.md. */
export function stylesheetLinks(): string {
  const v = bundleVersion();
  const theme = themeName();
  return `<link rel="stylesheet" href="/static/base.css${v}"/>
<link rel="stylesheet" href="/static/themes/${theme}.css${v}"/>`;
}

export interface SiteChrome {
  /** Resolved site config — owner-side branding only; never per-request. */
  site: { title: string; tagline?: string };
}

export interface HeadOpts {
  /** True when the request carries a valid admin session. Adds the
   * admin strip to the header (New post / Edit / Logout). */
  isAdmin?: boolean;
  /** The slug of the post currently being viewed, if any. When set
   * AND isAdmin, the strip includes an "Edit this post" link. */
  currentSlug?: string;
}

export function siteHead(site: SiteChrome['site'], opts: HeadOpts = {}): string {
  const tagline = site.tagline
    ? `<span class="rkr-site-tagline">${escapeText(site.tagline)}</span>`
    : '';
  const adminStrip = opts.isAdmin ? renderAdminStrip(opts.currentSlug) : '';
  return `<a class="rkr-skip" href="#main">Skip to content</a>
<header class="rkr-site-head">
  <div class="rkr-site-head-inner">
    <p class="rkr-site-title"><a href="/">${escapeText(site.title)}</a></p>
    ${tagline}
  </div>${adminStrip}
</header>`;
}

function renderAdminStrip(currentSlug?: string): string {
  // Edit-this-post only appears on /:slug pages; the slug must be
  // URL-encoded because the editor passes it via querystring.
  const editLink = currentSlug
    ? `<a class="rkr-admin-strip-link" href="/admin/editor?slug=${encodeURIComponent(currentSlug)}">Edit this post</a>`
    : '';
  // Logout is POST to defeat CSRF + the cross-origin guard; inline
  // form-submit is the standard answer.
  return `
  <nav class="rkr-admin-strip" aria-label="Admin">
    <a class="rkr-admin-strip-link" href="/admin/editor">New post</a>
    <a class="rkr-admin-strip-link" href="/admin/posts">Posts</a>
    ${editLink}
    <form method="post" action="/admin/logout" class="rkr-admin-strip-logout">
      <button type="submit" class="rkr-admin-strip-link">Logout</button>
    </form>
  </nav>`;
}

export function siteFoot(site: SiteChrome['site']): string {
  const year = new Date().getFullYear();
  // /admin/login is reachable directly but no link from the public
  // chrome would have you find it; a discreet footer link is enough.
  return `<footer class="rkr-site-foot">
  &copy; ${year} ${escapeAttr(site.title)}
  <span class="rkr-site-foot-sep" aria-hidden="true">·</span>
  <a class="rkr-site-foot-admin" href="/admin/login" rel="nofollow">Admin</a>
</footer>`;
}
