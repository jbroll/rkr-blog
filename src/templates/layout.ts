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

import { escapeAttr, escapeText } from '../lib/content.ts';
import { icon } from './icons.ts';
import { renderAnnouncement, renderMenuHeader, type SiteNavChrome } from './site-nav.ts';

/** Everything a template needs to build an asset URL: the active
 * theme, the build hash used as the ?v= cache-buster, and the URL
 * prefix the assets are served from ('/static' publicly,
 * '/admin/static' inside the admin service worker's scope). */
export interface AssetCtx {
  theme: string;
  hash: string;
  base: string;
}

export function bundleVersion(a: AssetCtx): string {
  return `?v=${a.hash}`;
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
export function headIcons(a: AssetCtx): string {
  const v = bundleVersion(a);
  return `<link rel="icon" type="image/x-icon" href="${a.base}/favicon.ico${v}"/>
<link rel="icon" type="image/png" sizes="32x32" href="${a.base}/icon-32.png${v}"/>
<link rel="apple-touch-icon" sizes="180x180" href="${a.base}/apple-touch-icon.png${v}"/>`;
}

/** Admin PWA hooks: the install manifest and the service worker that
 * lets the block editor open offline. Admin pages only. */
export function adminPwaHead(a: AssetCtx): string {
  const v = bundleVersion(a);
  return `<link rel="manifest" href="${a.base}/admin-manifest.webmanifest${v}"/>
<script type="module" src="${a.base}/site/sw-admin-register.js${v}" defer></script>`;
}

export function stylesheetLinks(a: AssetCtx): string {
  const v = bundleVersion(a);
  const base = `<meta name="color-scheme" content="light dark"/>
<link rel="stylesheet" href="${a.base}/base.css${v}"/>
<link rel="stylesheet" href="${a.base}/themes/default.css${v}"/>`;
  if (a.theme === 'default') return base;
  return `${base}
<link rel="stylesheet" href="${a.base}/themes/${a.theme}.css${v}"/>`;
}

export interface SiteChrome {
  /** Resolved site config — owner-side branding only; never per-request. */
  site: { title: string; tagline?: string };
  assets: AssetCtx;
  /** Header settings (menu, logo, CTA, social, announcement). */
  chrome?: SiteNavChrome;
}

export interface HeadOpts {
  /** Controls the Login/Logout affordance in the header top-right.
   * When true, renders a Logout POST form; when false/omitted, a Login link. */
  isAdmin?: boolean;
  /** Omit the "Home" nav link (the index page links to itself). */
  hideHomeLink?: boolean;
  /** Deployed commit hash to display in the header. Omitted → no badge. */
  buildHash?: string;
  /** Where the sign-out script loads from; admin pages pass the
   * /admin/static base so it stays inside the worker's scope. */
  assets?: AssetCtx;
  /** With a menu set, the header is built by site-nav.ts. */
  chrome?: SiteNavChrome;
}

/** No-JS site search form for the header nav (post-listing pages).
 * GET so it works without JavaScript; the focus-expand is pure CSS. */
export function renderSearchForm(q = ''): string {
  return `<form class="rkr-site-search" method="get" action="/search" role="search"><input type="search" name="q" value="${escapeAttr(q)}" placeholder="Search…" aria-label="Search posts"/></form>`;
}

function siteScript(a: AssetCtx | undefined, name: string): string {
  return a ? `${a.base}/site/${name}${bundleVersion(a)}` : `/static/site/${name}`;
}

export function siteHead(site: SiteChrome['site'], opts: HeadOpts = {}): string {
  const tagline = site.tagline
    ? `<span class="rkr-site-tagline">${escapeText(site.tagline)}</span>`
    : '';
  const versionSpan = opts.buildHash
    ? `<span class="rkr-site-head-version" title="Deployed commit">${escapeText(opts.buildHash)}</span>`
    : '';
  // signout.js asks before a sign-out deletes unsynced page drafts.
  const auth = opts.isAdmin
    ? `<form method="post" action="/admin/logout" class="rkr-site-head-auth-form">
    <button type="submit" class="rkr-site-head-auth-btn">Logout</button>
  </form>
  <script type="module" src="${siteScript(opts.assets, 'signout.js')}"></script>`
    : `<a class="rkr-site-head-auth-btn" href="/login" rel="nofollow">Login</a>`;
  const chrome = opts.chrome;
  const bar = renderAnnouncement(chrome?.announcement, siteScript(opts.assets, 'announcement.js'));
  if (chrome?.menu?.length) {
    return `${bar}${renderMenuHeader(chrome, {
      title: site.title,
      ...(site.tagline ? { tagline: site.tagline } : {}),
      versionHtml: versionSpan,
      authHtml: opts.isAdmin ? auth : ''
    })}`;
  }
  return `${bar}<a class="rkr-skip" href="#main">Skip to content</a>
<header class="rkr-site-head">
  <div class="rkr-site-head-inner">
    <div class="rkr-site-head-brand">
      <p class="rkr-site-title"><a href="/">${escapeText(site.title)}</a></p>
      ${tagline}
    </div>
    ${versionSpan}
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
  /** Rendered `_footer` block page; replaces the copyright line. */
  footerHtml?: string;
}

export const footerOpt = (chrome?: SiteNavChrome): FootOpts =>
  chrome?.footerHtml ? { footerHtml: chrome.footerHtml } : {};

/** The footer's admin link is the only sign-in path once a menu replaces
 * the header's Login link. */
export function siteFoot(site: SiteChrome['site'], opts: FootOpts = {}): string {
  const adminLink = `<a class="rkr-site-foot-admin" href="${opts.isAdmin ? '/admin/blocks' : '/login'}">Admin</a>`;
  if (opts.footerHtml) {
    return `<footer class="rkr-site-foot">${opts.footerHtml}${adminLink}</footer>`;
  }
  const year = new Date().getFullYear();
  return `<footer class="rkr-site-foot">
  &copy; ${year} ${escapeText(site.title)} &mdash; <a href="https://github.com/jbroll/rkr-blog">GitHub</a> ${adminLink}
</footer>`;
}

/** FAB row rendered on the homepage when the visitor is authed:
 *  ⚙ Settings on top, + New page below. Stacked bottom-right. */
export function indexAdminFabs(): string {
  return `<a class="rkr-fab rkr-fab--slot-3" href="/admin/comments" aria-label="Moderate comments" title="Moderate comments">
  ${icon('comment', 22)}
</a>
<a class="rkr-fab rkr-fab--slot-2" href="/admin/settings" aria-label="Settings" title="Settings">
  ${icon('settings', 22)}
</a>
<a class="rkr-fab rkr-fab--slot-1" href="/admin/blocks/new" aria-label="New page" title="New page">
  ${icon('plus', 24)}
</a>`;
}

/** FAB rendered on /:slug pages when the visitor is authed:
 * a pencil that routes into the blocks editor for this page's slug. */
export function postAdminFab(slug: string): string {
  const href = `/admin/blocks/edit/${encodeURIComponent(slug)}`;
  return `<a class="rkr-fab rkr-fab--slot-1" href="${escapeAttr(href)}" aria-label="Edit this post" title="Edit this post">
  ${icon('pencil', 22)}
</a>`;
}
