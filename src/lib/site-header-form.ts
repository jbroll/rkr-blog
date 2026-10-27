// Turns the settings form's header section into a site.json patch.
// The urlencoded parser keeps only the last value of a repeated name, so
// rows are numbered (`menu.0.label`). A field missing from the body
// leaves the stored value alone; pickOrgFields validates what is sent.

import type { NavLink, OrgSiteFields, SocialLink } from './site-org-settings.ts';

type Body = Record<string, unknown>;

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function rows(body: Body, prefix: string, a: string, b: string): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; `${prefix}.${i}.${a}` in body || `${prefix}.${i}.${b}` in body; i++) {
    const pair: [string, string] = [
      text(body[`${prefix}.${i}.${a}`]),
      text(body[`${prefix}.${i}.${b}`])
    ];
    if (pair[0] || pair[1]) out.push(pair);
  }
  return out;
}

const hasRows = (body: Body, prefix: string): boolean =>
  Object.keys(body).some((k) => k.startsWith(`${prefix}.`));

function emailUrl(platform: string, url: string): string {
  return platform === 'email' && url.includes('@') && !url.includes(':') ? `mailto:${url}` : url;
}

export function parseHeaderForm(body: Body): OrgSiteFields {
  const out: OrgSiteFields = {};
  if ('logo' in body) out.logo = text(body.logo);
  if (hasRows(body, 'menu')) {
    out.menu = rows(body, 'menu', 'label', 'href').map(
      ([label, href]): NavLink => ({ label, href })
    );
  }
  if ('ctaLabel' in body) out.cta = { label: text(body.ctaLabel), href: text(body.ctaHref) };
  if (hasRows(body, 'social')) {
    out.social = rows(body, 'social', 'platform', 'url')
      .filter(([, url]) => url)
      .map(([platform, url]) => ({ platform, url: emailUrl(platform, url) }) as SocialLink);
  }
  if ('announcementText' in body) {
    const href = text(body.announcementHref);
    out.announcement = {
      text: text(body.announcementText),
      on: 'announcementOn' in body,
      ...(href ? { href } : {})
    };
  }
  return out;
}
