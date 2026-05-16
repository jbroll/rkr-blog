// GET + POST /admin/settings — operator UI for the persisted
// blog-level config (title / tagline / theme). lib/config.ts already
// owns the read + write primitives + theme-cache invalidation; this
// route is the HTML form glue around them.
//
// POST validates field types and lengths, writes via
// writePersistedSiteConfig (so a partial form submission keeps fields
// it didn't change), and 303-redirects back to GET with a flash
// message. The redirect avoids the "refresh re-submits the form"
// foot-gun and keeps the flow indistinguishable from a server-side
// SPA from the operator's perspective.

import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { resolveGitHash } from '../lib/build-info.ts';
import {
  listAvailableThemes,
  type PersistedIngestResize,
  readPersistedSiteConfig,
  siteConfig,
  writePersistedSiteConfig
} from '../lib/config.ts';
import type { Db } from '../lib/db.ts';
import { INGEST_RESIZE_BOUNDS } from '../lib/image-constants.ts';
import { deleteToken, readToken } from '../lib/oauth-tokens.ts';
import { readSecretKey } from '../lib/secrets.ts';
import { renderAdminSettingsPage } from '../templates/admin-settings.ts';

const MAX_TITLE = 200;
const MAX_TAGLINE = 500;
// Match VALID_THEME_NAME in lib/config.ts. Keep in sync — the regex
// is the security boundary for the theme name (it ends up in a CSS
// URL path).
const VALID_THEME_NAME = /^[a-z][a-z0-9-]*$/;

export interface AdminSettingsRoutesOpts {
  guard: Record<string, unknown>;
  db?: Db;
  siteRoot: string;
}

export function registerAdminSettingsRoutes(
  fastify: FastifyInstance,
  opts: AdminSettingsRoutesOpts
): void {
  const { guard, db, siteRoot } = opts;

  fastify.get<{ Querystring: { flash?: string; err?: string } }>(
    '/admin/settings',
    { ...guard },
    async (req, reply) => {
      const persisted = readPersistedSiteConfig();
      const themes = listAvailableThemes();
      const site = siteConfig();
      const flash = decodeFlash(req.query);
      const gitHash = resolveGitHash();
      const user = req.user;
      let gdriveConnected = false;
      let onedriveConnected = false;
      if (user && db) {
        const key = readSecretKey(siteRoot);
        gdriveConnected = readToken(db, key, user.id, 'gdrive') !== null;
        onedriveConnected = readToken(db, key, user.id, 'onedrive') !== null;
      }
      const hasBanner = fs.existsSync(
        path.join(siteRoot, 'content', 'posts', '_site-banner.md')
      );
      return reply.type('text/html; charset=utf-8').send(
        renderAdminSettingsPage({
          site,
          persisted,
          themes,
          flash,
          gitHash,
          gdriveConnected,
          onedriveConnected,
          hasBanner
        })
      );
    }
  );

  fastify.post('/admin/settings/onedrive/disconnect', { ...guard }, async (req, reply) => {
    const user = req.user;
    if (user && db) {
      deleteToken(db, user.id, 'onedrive');
    }
    return reply.redirect('/admin/settings', 303);
  });

  fastify.post('/admin/settings/gdrive/disconnect', { ...guard }, async (req, reply) => {
    const user = req.user;
    if (user && db) {
      deleteToken(db, user.id, 'gdrive');
    }
    return reply.redirect('/admin/settings', 303);
  });

  fastify.post<{
    Body: {
      title?: unknown;
      tagline?: unknown;
      theme?: unknown;
      ingestMaxDim?: unknown;
      ingestScalePct?: unknown;
      ingestWebpQuality?: unknown;
    };
  }>('/admin/settings', { ...guard }, async (request, reply) => {
    const body = request.body ?? {};
    const titleRaw = typeof body.title === 'string' ? body.title.trim() : '';
    const taglineRaw = typeof body.tagline === 'string' ? body.tagline.trim() : '';
    const themeRaw = typeof body.theme === 'string' ? body.theme.trim() : '';

    if (titleRaw.length > MAX_TITLE) {
      return reply.redirect(`/admin/settings?err=${encodeURIComponent('title too long')}`, 303);
    }
    if (taglineRaw.length > MAX_TAGLINE) {
      return reply.redirect(`/admin/settings?err=${encodeURIComponent('subtitle too long')}`, 303);
    }
    // Theme is constrained both server-side (file must exist) and at
    // the regex level (no slashes / dots, so a "../etc/passwd" can't
    // sneak through as a stylesheet href). An invalid name surfaces
    // here as a 400 rather than silently falling back, so the
    // operator notices the typo immediately.
    if (themeRaw && !VALID_THEME_NAME.test(themeRaw)) {
      return reply.redirect(`/admin/settings?err=${encodeURIComponent('invalid theme name')}`, 303);
    }
    if (themeRaw && !listAvailableThemes().includes(themeRaw)) {
      return reply.redirect(
        `/admin/settings?err=${encodeURIComponent('theme not installed')}`,
        303
      );
    }

    // Ingest knobs: blank string clears the override, otherwise parse
    // and reject anything outside INGEST_RESIZE_BOUNDS so the operator
    // sees a flash error instead of a silent clamp. Returning the form
    // value verbatim on error would be friendlier, but the redirect
    // pattern this route uses doesn't carry state — the form re-renders
    // from persisted (which we haven't written yet), so a typo just
    // doesn't take effect rather than being preserved-with-warning.
    const maxDim = parseIngestField(body.ingestMaxDim, 'max image dimension');
    if ('error' in maxDim) {
      return reply.redirect(`/admin/settings?err=${encodeURIComponent(maxDim.error)}`, 303);
    }
    const scalePct = parseIngestField(body.ingestScalePct, 'scale percentage');
    if ('error' in scalePct) {
      return reply.redirect(`/admin/settings?err=${encodeURIComponent(scalePct.error)}`, 303);
    }
    const webpQuality = parseIngestField(body.ingestWebpQuality, 'webp quality');
    if ('error' in webpQuality) {
      return reply.redirect(`/admin/settings?err=${encodeURIComponent(webpQuality.error)}`, 303);
    }
    const ingestResize = buildIngestResize({
      maxDim: maxDim.value,
      scalePct: scalePct.value,
      webpQuality: webpQuality.value
    });

    // Persist the form values verbatim, empty strings included.
    // siteConfig() / themeName() each treat an empty-string persisted
    // field as falsy (the `||` chain falls through to SITE_TITLE /
    // SITE_TAGLINE / SITE_THEME), so a cleared field correctly
    // re-engages the env-var fallback at read time. The on-disk JSON
    // ends up with `"title": ""` for a cleared override — cosmetic,
    // but unambiguous about what the operator set.
    writePersistedSiteConfig({
      title: titleRaw,
      tagline: taglineRaw,
      theme: themeRaw,
      ...(ingestResize ? { ingestResize } : {})
    });

    return reply.redirect('/admin/settings?flash=saved', 303);
  });

  // POST /admin/settings/site — set title and tagline via JSON API.
  // Called by `site-admin import-wp site-banner` to push WP site metadata.
  fastify.post<{ Body: { title?: unknown; tagline?: unknown } }>(
    '/admin/settings/site',
    { ...guard },
    async (request, reply) => {
      const { title, tagline } = request.body ?? {};
      if (typeof title !== 'string') {
        return reply.code(400).send({ error: 'title is required' });
      }
      const titleTrimmed = title.trim();
      const taglineTrimmed = typeof tagline === 'string' ? tagline.trim() : '';
      if (titleTrimmed.length > MAX_TITLE) {
        return reply.code(400).send({ error: 'title too long' });
      }
      if (taglineTrimmed.length > MAX_TAGLINE) {
        return reply.code(400).send({ error: 'tagline too long' });
      }
      writePersistedSiteConfig({ title: titleTrimmed, tagline: taglineTrimmed });
      return reply.send({ ok: true, title: titleTrimmed, tagline: taglineTrimmed });
    }
  );

  // GET /admin/banner/edit — create _site-banner.md if absent, then open it
  // in the editor. Hides the _site-banner slug from the settings UI.
  fastify.get('/admin/banner/edit', { ...guard }, async (_req, reply) => {
    const bannerPath = path.join(siteRoot, 'content', 'posts', '_site-banner.md');
    const exists = fs.existsSync(bannerPath);
    const raw = exists ? fs.readFileSync(bannerPath, 'utf8') : '';
    const hasFigure = raw.includes('::figure');
    if (!exists || (!hasFigure && siteConfig().bannerImageId)) {
      const { bannerImageId } = siteConfig();
      const body = bannerImageId ? `\n::figure{ids="${bannerImageId}" justify=bleed}\n` : '';
      fs.writeFileSync(
        bannerPath,
        `---\nslug: _site-banner\ntitle: Site Banner\nstatus: published\n---\n${body}`
      );
    }
    return reply.redirect('/admin/editor?slug=_site-banner&mode=figure', 302);
  });

  // POST /admin/settings/banner — set the site-wide banner image by ID.
  // Called by `site-admin import-wp site-banner` after uploading the image.
  fastify.post<{ Body: { imageId?: unknown } }>(
    '/admin/settings/banner',
    { ...guard },
    async (request, reply) => {
      const { imageId } = request.body ?? {};
      if (typeof imageId !== 'string' || !/^[0-9a-f]{64}$/.test(imageId)) {
        return reply.code(400).send({ error: 'imageId must be a 64-char hex sidecar ID' });
      }
      writePersistedSiteConfig({ bannerImageId: imageId });
      return reply.send({ ok: true, bannerImageId: imageId });
    }
  );
}

/** Form-field parser for the three numeric ingest knobs. Returns
 * `{ value }` (number when set, undefined when the operator cleared
 * the field) or `{ error }` for non-numeric / out-of-bounds input. */
function parseIngestField(
  raw: unknown,
  label: string
): { value: number | undefined } | { error: string } {
  if (raw === undefined || raw === null) return { value: undefined };
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s === '') return { value: undefined };
  const n = Number(s);
  if (!Number.isFinite(n)) return { error: `${label} must be a number` };
  const bounds = boundsForLabel(label);
  if (n < bounds.min || n > bounds.max) {
    return { error: `${label} must be between ${bounds.min} and ${bounds.max}` };
  }
  return { value: Math.round(n) };
}

function boundsForLabel(label: string): { min: number; max: number } {
  if (label === 'max image dimension') return INGEST_RESIZE_BOUNDS.maxDim;
  if (label === 'scale percentage') return INGEST_RESIZE_BOUNDS.scalePct;
  return INGEST_RESIZE_BOUNDS.webpQuality;
}

function buildIngestResize(parts: {
  maxDim: number | undefined;
  scalePct: number | undefined;
  webpQuality: number | undefined;
}): PersistedIngestResize | undefined {
  const out: PersistedIngestResize = {};
  if (parts.maxDim !== undefined) out.maxDim = parts.maxDim;
  if (parts.scalePct !== undefined) out.scalePct = parts.scalePct;
  if (parts.webpQuality !== undefined) out.webpQuality = parts.webpQuality;
  return Object.keys(out).length > 0 ? out : undefined;
}

function decodeFlash(query: {
  flash?: string;
  err?: string;
}): { kind: 'ok' | 'error'; text: string } | undefined {
  if (typeof query.err === 'string' && query.err) {
    return { kind: 'error', text: query.err };
  }
  if (query.flash === 'saved') {
    return { kind: 'ok', text: 'Settings saved.' };
  }
  return undefined;
}
