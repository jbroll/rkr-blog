// The admin SPA shell, served at both /admin/editor and
// /admin/view/:slug — split out of admin.ts to keep that file under
// the 500-line cap.

import type { FastifyInstance, FastifyReply, RouteShorthandOptions } from 'fastify';

import { siteConfig } from '../lib/config.ts';
import { serverAssets } from '../lib/site-assets.ts';
import { renderAdminPage } from '../templates/admin.ts';
import { buildAdminEditorCsp, makeCspNonce } from './admin-csp.ts';

export function registerShellRoutes(
  fastify: FastifyInstance,
  opts: { guard: RouteShorthandOptions }
): void {
  const { guard } = opts;

  const sendShell = (reply: FastifyReply) => {
    // Per-RESPONSE nonce: binds the template's inline <style> block so
    // the CSP can drop script-src 'unsafe-inline' (see admin-csp.ts).
    const nonce = makeCspNonce();
    const assets = serverAssets('/admin/static');
    return reply
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', buildAdminEditorCsp(nonce))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'strict-origin-when-cross-origin')
      .send(
        renderAdminPage({
          site: siteConfig(),
          assets,
          bundleUrl: `/admin/static/admin/main.js?v=${assets.hash}`,
          cspNonce: nonce
        })
      );
  };

  fastify.get('/admin/editor', { ...guard }, async (_req, reply) => sendShell(reply));
  // Same shell, slug-independent: the bundle reads the slug from the
  // path, so one cached copy serves every post.
  fastify.get('/admin/view/:slug', { ...guard }, async (_req, reply) => sendShell(reply));
}
