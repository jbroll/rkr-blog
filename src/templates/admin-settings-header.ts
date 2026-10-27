// Header section of the settings form: logo, menu rows, CTA, social rows
// and the announcement. Field names match lib/site-header-form.ts.

import { escapeAttr } from '../lib/content.ts';
import {
  MAX_ANNOUNCEMENT,
  MAX_LABEL,
  MAX_MENU_ITEMS,
  MAX_SOCIAL_LINKS,
  type NavLink,
  type OrgSiteFields,
  SOCIAL_PLATFORMS,
  type SocialLink
} from '../lib/site-org-settings.ts';

const BLANK_ROWS = 3;

export const HEADER_SETTINGS_CSS = `.rkr-admin-settings-rows{grid-column:1/-1;border:0;padding:0;margin:0;display:grid;gap:.4rem}
.rkr-admin-settings-row{display:flex;gap:.5rem}
.rkr-admin-settings-row>*{flex:1;min-width:0}
.rkr-admin-settings-logo{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap}
.rkr-admin-settings-logo img{max-height:3rem;width:auto}`;

const input = (name: string, value: string, extra: string): string =>
  `<input name="${name}" type="text" value="${escapeAttr(value)}" ${extra}/>`;

function blankRows<T>(rows: T[], blank: T, max: number): T[] {
  const count = Math.min(rows.length + BLANK_ROWS, max);
  return [...rows, ...Array.from({ length: Math.max(0, count - rows.length) }, () => blank)];
}

function renderLogo(logo: string | undefined): string {
  const hidden = logo ? '' : ' hidden';
  const src = logo ? ` src="/admin/preview/${escapeAttr(logo)}"` : '';
  return `<label for="rkr-settings-logo-file">Logo</label>
  <div class="rkr-admin-settings-logo">
    <input type="hidden" name="logo" value="${escapeAttr(logo ?? '')}"/>
    <img class="rkr-admin-settings-logo-thumb"${src} alt="Current logo"${hidden}/>
    <input id="rkr-settings-logo-file" type="file" accept="image/*"/>
    <button type="button" class="rkr-admin-settings-logo-remove"${hidden}>Remove</button>
  </div>`;
}

function renderMenuRows(menu: NavLink[]): string {
  return blankRows(menu, { label: '', href: '' }, MAX_MENU_ITEMS)
    .map(
      (m, i) => `<div class="rkr-admin-settings-row">
      ${input(`menu.${i}.label`, m.label, `maxlength="${MAX_LABEL}" placeholder="Label" aria-label="Menu link ${i + 1} label"`)}
      ${input(`menu.${i}.href`, m.href, `placeholder="/page or https://…" aria-label="Menu link ${i + 1} address"`)}
    </div>`
    )
    .join('\n    ');
}

function platformOptions(selected: string): string {
  return SOCIAL_PLATFORMS.map(
    (p) => `<option value="${p}"${p === selected ? ' selected' : ''}>${p}</option>`
  ).join('');
}

function renderSocialRows(social: SocialLink[]): string {
  return blankRows<SocialLink>(social, { platform: 'facebook', url: '' }, MAX_SOCIAL_LINKS)
    .map(
      (s, i) => `<div class="rkr-admin-settings-row">
      <select name="social.${i}.platform" aria-label="Social link ${i + 1} service">${platformOptions(s.platform)}</select>
      ${input(`social.${i}.url`, s.url, `placeholder="https://… or mailto:…" aria-label="Social link ${i + 1} address"`)}
    </div>`
    )
    .join('\n    ');
}

export function renderHeaderSettings(p: OrgSiteFields): string {
  const a = p.announcement;
  return `<h2 class="rkr-admin-settings-section">Header</h2>
  <p class="rkr-admin-settings-note" style="grid-column:1/-1">With at least one menu link, the header shows the logo, menu, button and social links in place of Home, About and Login.</p>
  ${renderLogo(p.logo)}
  <fieldset class="rkr-admin-settings-rows">
    <legend>Menu</legend>
    ${renderMenuRows(p.menu ?? [])}
  </fieldset>
  <label for="rkr-settings-cta-label">Button label</label>
  ${input('ctaLabel', p.cta?.label ?? '', `id="rkr-settings-cta-label" maxlength="${MAX_LABEL}"`)}
  <label for="rkr-settings-cta-href">Button link</label>
  ${input('ctaHref', p.cta?.href ?? '', 'id="rkr-settings-cta-href"')}
  <fieldset class="rkr-admin-settings-rows">
    <legend>Social links</legend>
    ${renderSocialRows(p.social ?? [])}
  </fieldset>
  <label for="rkr-settings-announcement-text">Announcement</label>
  ${input('announcementText', a?.text ?? '', `id="rkr-settings-announcement-text" maxlength="${MAX_ANNOUNCEMENT}"`)}
  <label for="rkr-settings-announcement-href">Announcement link</label>
  ${input('announcementHref', a?.href ?? '', 'id="rkr-settings-announcement-href" placeholder="optional"')}
  <label for="rkr-settings-announcement-on">Show the announcement</label>
  <input id="rkr-settings-announcement-on" name="announcementOn" type="checkbox"${a?.on ? ' checked' : ''}/>`;
}
