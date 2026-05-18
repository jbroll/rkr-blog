// Shared site chrome: header + footer used by both /:slug and / templates.
// Driven by SITE_TITLE / SITE_TAGLINE env vars (lib/config.ts).
//
// Admin chrome is split between two surfaces:
//   * Floating action buttons (FABs) on the public pages — pencil
//     icon on /:slug for "Edit this post", plus + and gear FABs on /
//     for "New post" + "Settings". Rendered by each template; see
//     adminFabs() helpers below.
//   * The header's top-right corner: "Login" for anonymous,
//     "Logout" for authed (POST form so CSRF/origin guards fire).

import { resolveGitHash } from '../lib/build-info.ts';
import { themeName } from '../lib/config.ts';
import { escapeAttr, escapeText } from '../lib/content.ts';
import { icon } from './icons.ts';

/** ?v=<short-hash> suffix appended to public-side bundle / stylesheet
 * URLs so the service worker (src/site/sw.ts) treats each deploy as a
 * distinct cache key. When the git hash can't be resolved, the
 * fallback suffix is `?v=unknown` — consistent per-process, so the SW
 * still caches deterministically (the deploy can re-warm by setting
 * GIT_HASH env). */
export function bundleVersion(): string {
  return `?v=${resolveGitHash().slice(0, 12)}`;
}

/** `<link>` tags for the public-side stylesheets, in cascade order:
 *
 *   1. base.css — a11y / overflow primitives that themes never override.
 *   2. themes/default.css — the full structural sheet. Always loaded so
 *      themes can layer on top without re-implementing the framework.
 *   3. themes/<name>.css — the active theme's overrides. Skipped when
 *      the active theme IS default. See docs/theming.md.
 *
 * Prefixed by a `<meta name="color-scheme" content="light dark">` so
 * the browser paints the pre-CSS canvas in the user's preferred
 * scheme. The CSS-side `color-scheme` declaration only takes effect
 * after the linked stylesheet loads — fine for SW-served navigations
 * (the HTML + CSS arrive together from cache) but not for routes the
 * SW bypasses (e.g. anything under /admin/), where the network gap between the
 * HTML and CSS lets dark-mode visitors see a brief white canvas. The
 * meta tag is parsed as the head streams in, before any external
 * stylesheet, and applies immediately.
 */
export function headIcons(): string {
  return `<link rel="icon" type="image/x-icon" href="/static/favicon.ico"/>
<link rel="icon" type="image/png" sizes="32x32" href="/static/icon-32.png"/>
<link rel="apple-touch-icon" sizes="180x180" href="/static/apple-touch-icon.png"/>`;
}

export function stylesheetLinks(): string {
  const v = bundleVersion();
  const theme = themeName();
  const base = `<meta name="color-scheme" content="light dark"/>
<link rel="stylesheet" href="/static/base.css${v}"/>
<link rel="stylesheet" href="/static/themes/default.css${v}"/>`;
  if (theme === 'default') return base;
  return `${base}
<link rel="stylesheet" href="/static/themes/${theme}.css${v}"/>`;
}

export interface SiteChrome {
  /** Resolved site config — owner-side branding only; never per-request. */
  site: { title: string; tagline?: string };
}

export interface HeadOpts {
  /** Controls the Login/Logout affordance in the header top-right.
   * When true, renders a Logout POST form; when false/omitted, a Login link. */
  isAdmin?: boolean;
  /** Omit the "Home" nav link (the index page links to itself). */
  hideHomeLink?: boolean;
}

/** No-JS site search form for the header nav (post-listing pages).
 * GET so it works without JavaScript; the focus-expand is pure CSS. */
export function renderSearchForm(q = ''): string {
  return `<form class="rkr-site-search" method="get" action="/search" role="search"><input type="search" name="q" value="${escapeAttr(q)}" placeholder="Search…" aria-label="Search posts"/></form>`;
}

export function siteHead(site: SiteChrome['site'], opts: HeadOpts = {}): string {
  const tagline = site.tagline
    ? `<span class="rkr-site-tagline">${escapeText(site.tagline)}</span>`
    : '';
  const auth = opts.isAdmin
    ? `<form method="post" action="/admin/logout" class="rkr-site-head-auth-form">
    <button type="submit" class="rkr-site-head-auth-btn">Logout</button>
  </form>`
    : `<a class="rkr-site-head-auth-btn" href="/login" rel="nofollow">Login</a>`;
  return `<a class="rkr-skip" href="#main">Skip to content</a>
<header class="rkr-site-head">
  <div class="rkr-site-head-inner">
    <div class="rkr-site-head-brand">
      <p class="rkr-site-title"><a href="/">${escapeText(site.title)}</a></p>
      ${tagline}
    </div>
    <nav class="rkr-site-head-nav" aria-label="Site">
      ${opts.hideHomeLink ? '' : '<a class="rkr-site-head-auth-btn" href="/">Home</a>'}
      <a class="rkr-site-head-auth-btn" href="/about">About</a>
      <div class="rkr-site-head-auth">${auth}</div>
    </nav>
  </div>
</header>`;
}

export interface FootOpts {
  isAdmin?: boolean;
}

export function siteFoot(site: SiteChrome['site'], _opts: FootOpts = {}): string {
  const year = new Date().getFullYear();
  return `<footer class="rkr-site-foot">
  &copy; ${year} ${escapeText(site.title)}
</footer>`;
}

/** FAB row rendered on the homepage when the visitor is authed:
 *  ⚙ Settings on top, + New post below. Stacked bottom-right. */
export function indexAdminFabs(): string {
  return `<a class="rkr-fab rkr-fab--slot-3" href="/admin/comments" aria-label="Moderate comments" title="Moderate comments">
  ${icon('comment', 22)}
</a>
<a class="rkr-fab rkr-fab--slot-2" href="/admin/settings" aria-label="Settings" title="Settings">
  ${icon('settings', 22)}
</a>
<a class="rkr-fab rkr-fab--slot-1" href="/admin/editor?new=1" aria-label="New post" title="New post">
  ${icon('plus', 24)}
</a>`;
}

/** FAB rendered on /:slug pages when the visitor is authed:
 * a pencil that routes into the editor with the post's slug. */
export function postAdminFab(slug: string): string {
  const href = `/admin/editor?slug=${encodeURIComponent(slug)}`;
  return `<a class="rkr-fab rkr-fab--slot-1" href="${escapeAttr(href)}" aria-label="Edit this post" title="Edit this post">
  ${icon('pencil', 22)}
</a>`;
}
