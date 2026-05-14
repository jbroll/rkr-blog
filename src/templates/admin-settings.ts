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
import { DEFAULT_INGEST_RESIZE, INGEST_RESIZE_BOUNDS } from '../lib/image-constants.ts';
import { icon } from './icons.ts';
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
    ingestResize?: {
      maxDim?: number;
      scalePct?: number;
      webpQuality?: number;
    };
  };
  /** All themes available on disk, default-first. Drives the <select>
   * options. */
  themes: string[];
  /** Optional flash message after a successful save / a validation
   * failure. Rendered above the form. */
  flash?: { kind: 'ok' | 'error'; text: string };
  /** Full git commit sha of the running build. Surfaced at the bottom
   * of the page so the operator can confirm which deploy is live
   * (matches /health's gitHash field). 'unknown' when neither a
   * GIT_COMMIT env var nor a build-time /app/git-hash file is set. */
  gitHash: string;
}

export function renderAdminSettingsPage(data: AdminSettingsPageData): string {
  const flash = data.flash?.kind === 'error' ? renderFlash(data.flash) : '';
  const saveBtn = `<button type="submit" class="rkr-admin-settings-submit" aria-label="Save settings" title="Save settings">${icon('save', 18)}</button>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Settings — ${escapeText(data.site.title)}</title>
${stylesheetLinks()}
<style>
.rkr-admin-settings-heading-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem}
.rkr-admin-settings-heading{margin:0}
.rkr-admin-settings-submit{display:flex;align-items:center;background:transparent;color:var(--rkr-link);border:1px solid var(--rkr-link);border-radius:4px;padding:.25rem .5rem;cursor:pointer;transition:background-color .15s ease-out,color .15s ease-out}
.rkr-admin-settings-submit.is-dirty{background:var(--rkr-link);color:var(--rkr-bg)}
.rkr-admin-settings-submit:hover{background:var(--rkr-link-hover,var(--rkr-link));color:var(--rkr-bg);border-color:var(--rkr-link-hover,var(--rkr-link))}
</style>
</head>
<body>
${siteHead(data.site, { isAdmin: true })}
<main id="main" tabindex="-1">
${flash}
<form method="post" action="/admin/settings" class="rkr-admin-settings">
<div class="rkr-admin-settings-heading-row">
<h1 class="rkr-admin-settings-heading">Site settings</h1>
${saveBtn}
</div>
  <label for="rkr-settings-title">Title</label>
  <input id="rkr-settings-title" name="title" type="text" maxlength="200" value="${escapeAttr(data.persisted.title ?? '')}" placeholder="${escapeAttr(data.site.title)}"/>

  <label for="rkr-settings-tagline">Subtitle</label>
  <input id="rkr-settings-tagline" name="tagline" type="text" maxlength="500" value="${escapeAttr(data.persisted.tagline ?? '')}" placeholder="optional"/>

  <label for="rkr-settings-theme">Theme</label>
  <select id="rkr-settings-theme" name="theme">
    ${renderThemeOptions(data.themes, data.persisted.theme)}
  </select>

  <h2 class="rkr-admin-settings-section">Image uploads</h2>

  <label for="rkr-settings-ingest-max-dim">Max long edge (px)</label>
  <input id="rkr-settings-ingest-max-dim" name="ingestMaxDim" type="number"
    min="${INGEST_RESIZE_BOUNDS.maxDim.min}" max="${INGEST_RESIZE_BOUNDS.maxDim.max}" step="1"
    value="${data.persisted.ingestResize?.maxDim ?? ''}"
    placeholder="${DEFAULT_INGEST_RESIZE.maxDim}"/>

  <label for="rkr-settings-ingest-scale">Downscale (%)</label>
  <input id="rkr-settings-ingest-scale" name="ingestScalePct" type="number"
    min="${INGEST_RESIZE_BOUNDS.scalePct.min}" max="${INGEST_RESIZE_BOUNDS.scalePct.max}" step="1"
    value="${data.persisted.ingestResize?.scalePct ?? ''}"
    placeholder="${DEFAULT_INGEST_RESIZE.scalePct}"/>

  <label for="rkr-settings-ingest-quality">WebP quality (lossy)</label>
  <input id="rkr-settings-ingest-quality" name="ingestWebpQuality" type="number"
    min="${INGEST_RESIZE_BOUNDS.webpQuality.min}" max="${INGEST_RESIZE_BOUNDS.webpQuality.max}" step="1"
    value="${data.persisted.ingestResize?.webpQuality ?? ''}"
    placeholder="${DEFAULT_INGEST_RESIZE.webpQuality}"/>
</form>
<p class="rkr-admin-settings-build">
  Build: <code title="${escapeAttr(data.gitHash)}">${escapeText(shortHash(data.gitHash))}</code>
</p>
</main>
${siteFoot(data.site, { isAdmin: true })}
<script type="module" src="/static/admin/settings-page.js"></script>
</body>
</html>
`;
}

function renderFlash(flash: { kind: 'ok' | 'error'; text: string }): string {
  return `<p class="rkr-admin-settings-flash is-${flash.kind}" role="status">${escapeText(flash.text)}</p>`;
}

/** Short-form display (first 12 chars) for the bottom-of-page chip;
 * full hash is in the title attribute for hover/copy. */
function shortHash(hash: string): string {
  return hash === 'unknown' ? hash : hash.slice(0, 12);
}

function renderThemeOptions(themes: string[], selected: string | undefined): string {
  return themes
    .map((name) => {
      const sel = name === selected ? ' selected' : '';
      return `<option value="${escapeAttr(name)}"${sel}>${escapeText(name)}</option>`;
    })
    .join('\n    ');
}
