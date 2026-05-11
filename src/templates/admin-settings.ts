// Admin settings page. Surfaces the blog-level config that already
// has a library API (lib/config.ts: read/writePersistedSiteConfig) but
// no operator UI — title, tagline, theme. Without this page an admin
// has to ssh / `fly ssh` into the box and edit config/site.json by
// hand, which defeats the "rewrite this file from the admin UI" intent
// the config module's docstring announces.
//
// Uses the public siteHead/siteFoot so themes apply here too; the
// admin strip is rendered (isAdmin: true) because the page is gated
// behind requireUser.

import { escapeAttr, escapeText } from '../lib/content.ts';
import { type SiteChrome, siteFoot, siteHead, stylesheetLinks } from './layout.ts';

export interface AdminSettingsPageData extends SiteChrome {
  /** Persisted values to pre-fill the form. Defaults from env vars
   * are deliberately NOT pre-filled — overwriting an unset persisted
   * field with the env default would make the env override sticky
   * even after the operator clears it. */
  persisted: {
    title?: string;
    tagline?: string;
    theme?: string;
  };
  /** All themes available on disk, default-first. Drives the <select>
   * options. */
  themes: string[];
  /** Optional flash message after a successful save / a validation
   * failure. Rendered above the form. */
  flash?: { kind: 'ok' | 'error'; text: string };
}

export function renderAdminSettingsPage(data: AdminSettingsPageData): string {
  const flash = data.flash ? renderFlash(data.flash) : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Settings — ${escapeText(data.site.title)}</title>
${stylesheetLinks()}
</head>
<body>
${siteHead(data.site, { isAdmin: true })}
<main id="main" tabindex="-1">
<h1 class="rkr-admin-settings-heading">Site settings</h1>
${flash}
<form method="post" action="/admin/settings" class="rkr-admin-settings">
  <label for="rkr-settings-title">Title</label>
  <input id="rkr-settings-title" name="title" type="text" maxlength="200" value="${escapeAttr(data.persisted.title ?? '')}" placeholder="${escapeAttr(data.site.title)}"/>

  <label for="rkr-settings-tagline">Subtitle</label>
  <input id="rkr-settings-tagline" name="tagline" type="text" maxlength="500" value="${escapeAttr(data.persisted.tagline ?? '')}" placeholder="optional"/>

  <label for="rkr-settings-theme">Theme</label>
  <select id="rkr-settings-theme" name="theme">
    ${renderThemeOptions(data.themes, data.persisted.theme)}
  </select>

  <p class="rkr-admin-settings-hint">
    Leaving title or subtitle blank falls back to the <code>SITE_TITLE</code> / <code>SITE_TAGLINE</code> environment variables (current default in the placeholder).
  </p>
  <button type="submit" class="rkr-admin-settings-submit">Save settings</button>
</form>
</main>
${siteFoot(data.site, { isAdmin: true })}
</body>
</html>
`;
}

function renderFlash(flash: { kind: 'ok' | 'error'; text: string }): string {
  return `<p class="rkr-admin-settings-flash is-${flash.kind}" role="status">${escapeText(flash.text)}</p>`;
}

function renderThemeOptions(themes: string[], selected: string | undefined): string {
  return themes
    .map((name) => {
      const sel = name === selected ? ' selected' : '';
      return `<option value="${escapeAttr(name)}"${sel}>${escapeText(name)}</option>`;
    })
    .join('\n    ');
}
