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

import type { FastifyInstance } from 'fastify';

import {
  listAvailableThemes,
  readPersistedSiteConfig,
  siteConfig,
  writePersistedSiteConfig
} from '../lib/config.ts';
import { renderAdminSettingsPage } from '../templates/admin-settings.ts';

const MAX_TITLE = 200;
const MAX_TAGLINE = 500;
// Match VALID_THEME_NAME in lib/config.ts. Keep in sync — the regex
// is the security boundary for the theme name (it ends up in a CSS
// URL path).
const VALID_THEME_NAME = /^[a-z][a-z0-9-]*$/;

export interface AdminSettingsRoutesOpts {
  guard: Record<string, unknown>;
}

export function registerAdminSettingsRoutes(
  fastify: FastifyInstance,
  opts: AdminSettingsRoutesOpts
): void {
  const { guard } = opts;

  fastify.get<{ Querystring: { flash?: string; err?: string } }>(
    '/admin/settings',
    { ...guard },
    async (req, reply) => {
      const persisted = readPersistedSiteConfig();
      const themes = listAvailableThemes();
      const site = siteConfig();
      const flash = decodeFlash(req.query);
      return reply
        .type('text/html; charset=utf-8')
        .send(renderAdminSettingsPage({ site, persisted, themes, flash }));
    }
  );

  fastify.post<{
    Body: { title?: unknown; tagline?: unknown; theme?: unknown };
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

    // Persist the form values verbatim, empty strings included.
    // siteConfig() / themeName() each treat an empty-string persisted
    // field as falsy (the `||` chain falls through to SITE_TITLE /
    // SITE_TAGLINE / SITE_THEME), so a cleared field correctly
    // re-engages the env-var fallback at read time. The on-disk JSON
    // ends up with `"title": ""` for a cleared override — cosmetic,
    // but unambiguous about what the operator set.
    writePersistedSiteConfig({ title: titleRaw, tagline: taglineRaw, theme: themeRaw });

    return reply.redirect('/admin/settings?flash=saved', 303);
  });
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
