// Header built from the site settings: logo, menu, CTA, social links,
// and the announcement bar above it. layout.ts siteHead switches to
// renderMenuHeader when a menu is set.

import crypto from 'node:crypto';
import { escapeAttr, escapeText } from '../lib/content.ts';
import { safeLinkUrl } from '../lib/safe-url.ts';
import type {
  Announcement,
  NavLink,
  SocialLink,
  SocialPlatform
} from '../lib/site-org-settings.ts';
import { icon } from './icons.ts';

/** Header settings resolved for one render; routes build it with
 * loadChrome (lib/site-chrome.ts). */
export interface SiteNavChrome {
  /** Trusted `<picture>` markup for the logo. */
  logoHtml?: string;
  menu?: NavLink[];
  cta?: NavLink;
  social?: SocialLink[];
  announcement?: Announcement;
  /** Trusted markup that replaces the default footer. */
  footerHtml?: string;
}

const SOCIAL_LABELS: Record<SocialPlatform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  youtube: 'YouTube',
  mastodon: 'Mastodon',
  bluesky: 'Bluesky',
  email: 'Email'
};

const href = (url: string): string => escapeAttr(safeLinkUrl(url));

/** Dismissal is remembered per text, so a new announcement shows again. */
function announcementKey(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** The bar, or '' when there is none to show. The close button stays
 * hidden until announcement.js wires it up. */
export function renderAnnouncement(a: Announcement | undefined, scriptSrc: string): string {
  if (!a?.on || !a.text) return '';
  const text = escapeText(a.text);
  const body = a.href ? `<a href="${href(a.href)}">${text}</a>` : text;
  return `<div class="rkr-announce" data-rkr-announce="${announcementKey(a.text)}">
  <p class="rkr-announce-text">${body}</p>
  <button type="button" class="rkr-announce-close" aria-label="Close announcement" hidden>&times;</button>
</div>
<script type="module" src="${escapeAttr(scriptSrc)}"></script>
`;
}

function renderSocial(social: SocialLink[] | undefined): string {
  if (!social?.length) return '';
  const items = social
    .map((s) => {
      const label = SOCIAL_LABELS[s.platform];
      return `<li><a href="${href(s.url)}" aria-label="${label}" title="${label}">${icon(s.platform, 20)}</a></li>`;
    })
    .join('');
  return `<ul class="rkr-site-social">${items}</ul>`;
}

export interface MenuHeaderParts {
  title: string;
  tagline?: string;
  /** Trusted markup layout.ts builds: build-hash badge and Logout slot. */
  versionHtml: string;
  authHtml: string;
}

export function renderMenuHeader(chrome: SiteNavChrome, parts: MenuHeaderParts): string {
  const title = escapeText(parts.title);
  const brand = chrome.logoHtml
    ? `<a href="/" aria-label="${escapeAttr(parts.title)}">${chrome.logoHtml}</a>`
    : `<a href="/">${title}</a>`;
  const tagline = parts.tagline
    ? `\n      <span class="rkr-site-tagline">${escapeText(parts.tagline)}</span>`
    : '';
  const links = (chrome.menu ?? [])
    .map(
      (m) =>
        `<li><a class="rkr-site-menu-link" href="${href(m.href)}">${escapeText(m.label)}</a></li>`
    )
    .join('');
  const cta = chrome.cta
    ? `\n      <a class="rkr-btn rkr-site-head-cta" href="${href(chrome.cta.href)}">${escapeText(chrome.cta.label)}</a>`
    : '';
  const auth = parts.authHtml
    ? `\n      <div class="rkr-site-head-auth">${parts.authHtml}</div>`
    : '';
  return `<a class="rkr-skip" href="#main">Skip to content</a>
<header class="rkr-site-head has-menu">
  <div class="rkr-site-head-inner">
    <div class="rkr-site-head-brand">
      <p class="rkr-site-title">${brand}</p>${tagline}
    </div>
    ${parts.versionHtml}
    <input type="checkbox" id="rkr-menu-toggle" class="rkr-menu-toggle"/>
    <label for="rkr-menu-toggle" class="rkr-menu-toggle-btn"><span class="rkr-menu-toggle-bars" aria-hidden="true"></span>Menu</label>
    <nav class="rkr-site-head-nav rkr-site-menu" aria-label="Site">
      <ul class="rkr-site-menu-list">${links}</ul>${cta}
      ${renderSocial(chrome.social)}${auth}
    </nav>
  </div>
</header>`;
}
