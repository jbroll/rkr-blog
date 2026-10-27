// Turns the settings form's header section into a site.json patch.
// The urlencoded parser keeps only the last value of a repeated name, so
// rows are numbered (`menu.0.label`). A field missing from the body
// leaves the stored value alone; pickOrgFields validates what is sent.

import {
  type NavLink,
  type OrgSiteFields,
  SOCIAL_PLATFORMS,
  type SocialLink
} from './site-org-settings.ts';

type Body = Record<string, unknown>;

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Every numbered row, blank ones included, as [first, second, number]. */
function rows(body: Body, prefix: string, a: string, b: string): [string, string, number][] {
  const out: [string, string, number][] = [];
  for (let i = 0; `${prefix}.${i}.${a}` in body || `${prefix}.${i}.${b}` in body; i++) {
    out.push([text(body[`${prefix}.${i}.${a}`]), text(body[`${prefix}.${i}.${b}`]), i + 1]);
  }
  return out;
}

const hasRows = (body: Body, prefix: string): boolean =>
  Object.keys(body).some((k) => k.startsWith(`${prefix}.`));

function emailUrl(platform: string, url: string): string {
  return platform === 'email' && url.includes('@') && !url.includes(':') ? `mailto:${url}` : url;
}

function parseMenu(body: Body): NavLink[] | string {
  const out: NavLink[] = [];
  for (const [label, href, n] of rows(body, 'menu', 'label', 'href')) {
    if (!label && !href) continue;
    if (!label || !href) return `Menu item ${n} needs both a label and a link.`;
    out.push({ label, href });
  }
  return out;
}

function parseSocial(body: Body): SocialLink[] | string {
  const out: SocialLink[] = [];
  for (const [platform, url, n] of rows(body, 'social', 'platform', 'url')) {
    if (!url) continue;
    const known = SOCIAL_PLATFORMS.find((p) => p === platform);
    if (!known) return `Social link ${n} needs a service.`;
    out.push({ platform: known, url: emailUrl(known, url) });
  }
  return out;
}

/** The patch, or an error naming the half-filled row. Fully blank rows
 * are ignored. */
export function parseHeaderForm(body: Body): { patch: OrgSiteFields } | { error: string } {
  const patch: OrgSiteFields = {};
  if ('logo' in body) patch.logo = text(body.logo);
  if (hasRows(body, 'menu')) {
    const menu = parseMenu(body);
    if (typeof menu === 'string') return { error: menu };
    patch.menu = menu;
  }
  if ('ctaLabel' in body) {
    const cta = { label: text(body.ctaLabel), href: text(body.ctaHref) };
    if (!cta.label !== !cta.href) {
      return { error: 'The header button needs both a label and a link.' };
    }
    patch.cta = cta;
  }
  if (hasRows(body, 'social')) {
    const social = parseSocial(body);
    if (typeof social === 'string') return { error: social };
    patch.social = social;
  }
  if ('announcementText' in body) {
    const href = text(body.announcementHref);
    patch.announcement = {
      text: text(body.announcementText),
      on: 'announcementOn' in body,
      ...(href ? { href } : {})
    };
  }
  return { patch };
}
