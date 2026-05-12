// Shared site chrome: header + footer used by both /:slug and / templates.
// Driven by SITE_TITLE / SITE_TAGLINE env vars (lib/config.ts).
//
// Admin chrome is split between two surfaces:
//   * Floating action buttons (FABs) on the public pages — pencil
//     icon on /:slug for "Edit this post", plus + and gear FABs on /
//     for "New post" + "Settings". Rendered by each template; see
//     adminFabs() helpers below.
//   * The footer's discreet entry point: "Login" for anonymous,
//     "Logout" for authed (POST form so CSRF/origin guards fire).

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
 * SW bypasses (e.g. /admin/login), where the network gap between the
 * HTML and CSS lets dark-mode visitors see a brief white canvas. The
 * meta tag is parsed as the head streams in, before any external
 * stylesheet, and applies immediately.
 */
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
  /** Admin context only affects the footer (Login → Logout swap)
   * and the per-page FABs that templates render. The header chrome
   * is identical for authed + anonymous visitors. */
  isAdmin?: boolean;
}

export function siteHead(site: SiteChrome['site'], _opts: HeadOpts = {}): string {
  const tagline = site.tagline
    ? `<span class="rkr-site-tagline">${escapeText(site.tagline)}</span>`
    : '';
  return `<a class="rkr-skip" href="#main">Skip to content</a>
<header class="rkr-site-head">
  <div class="rkr-site-head-inner">
    <p class="rkr-site-title"><a href="/">${escapeText(site.title)}</a></p>
    ${tagline}
  </div>
</header>`;
}

export interface FootOpts {
  /** When true the discreet footer link is "Logout" (POST form); when
   * false (or omitted) it's "Login" pointing at /admin/login. */
  isAdmin?: boolean;
}

export function siteFoot(site: SiteChrome['site'], opts: FootOpts = {}): string {
  const year = new Date().getFullYear();
  // The footer carries the only auth-state affordance now that the
  // admin strip is gone: anonymous visitors see a Login link;
  // authed visitors see a Logout form-button (POST so the
  // CSRF/origin guard fires).
  const adminLink = opts.isAdmin
    ? `<span class="rkr-site-foot-sep" aria-hidden="true">·</span>
  <form method="post" action="/admin/logout" class="rkr-site-foot-logout-form">
    <button type="submit" class="rkr-site-foot-admin">Logout</button>
  </form>`
    : `<span class="rkr-site-foot-sep" aria-hidden="true">·</span>
  <a class="rkr-site-foot-admin" href="/admin/login" rel="nofollow">Login</a>`;
  return `<footer class="rkr-site-foot">
  &copy; ${year} ${escapeAttr(site.title)}
  ${adminLink}
</footer>`;
}

/** FAB row rendered on the homepage when the visitor is authed:
 *  ⚙ Settings on top, + New post below. Stacked bottom-right. */
export function indexAdminFabs(): string {
  return `<a class="rkr-fab rkr-fab--slot-2" href="/admin/settings" aria-label="Settings" title="Settings">
  <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true" focusable="false">
    <path d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.04 7.04 0 0 0-1.62-.94l-.36-2.54A.5.5 0 0 0 13.91 2h-3.83a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.55-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.69 8.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.43.34.69.22l2.39-.96c.49.39 1.03.7 1.62.94l.36 2.54c.05.24.26.42.5.42h3.83c.24 0 .45-.18.5-.42l.36-2.54c.59-.24 1.13-.55 1.62-.94l2.39.96c.26.12.55.02.69-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/>
  </svg>
</a>
<a class="rkr-fab rkr-fab--slot-1" href="/admin/editor?new=1" aria-label="New post" title="New post">
  <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true" focusable="false">
    <path d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z"/>
  </svg>
</a>`;
}

/** FAB rendered on /:slug pages when the visitor is authed:
 * a pencil that routes into the editor with the post's slug. */
export function postAdminFab(slug: string): string {
  const href = `/admin/editor?slug=${encodeURIComponent(slug)}`;
  return `<a class="rkr-fab rkr-fab--slot-1" href="${escapeAttr(href)}" aria-label="Edit this post" title="Edit this post">
  <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true" focusable="false">
    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
  </svg>
</a>`;
}
