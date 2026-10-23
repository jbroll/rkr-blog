// The admin SPA shell, served at /admin/view/:slug for Preview.
//
// The legacy markdown editor entry point (/admin/editor) was retired in
// the JSON cutover: every edit now goes through the blocks editor
// (/admin/blocks*), which renders its own page. The old URL survives as
// a 404 that points authors at the replacement instead of dead-ending
// an old bookmark.
//
// Split out of admin.ts to keep that file under the 500-line cap.

import type { FastifyInstance, FastifyReply, RouteShorthandOptions } from 'fastify';

import { siteConfig } from '../lib/config.ts';
import { setPublicSecurityHeaders } from '../lib/security-headers.ts';
import { serverAssets } from '../lib/site-assets.ts';
import { renderAdminPage } from '../templates/admin.ts';
import { buildAdminEditorCsp, makeCspNonce } from './admin-csp.ts';

function sendRetiredEditor(reply: FastifyReply) {
  setPublicSecurityHeaders(reply);
  return reply
    .code(404)
    .type('text/html; charset=utf-8')
    .send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Editor retired</title></head>
<body><main><h1>Editor retired</h1>
<p>The markdown editor is gone. Every page is now edited in the blocks editor.</p>
<p><a href="/admin/blocks">Open the blocks editor →</a></p>
</main></body></html>`);
}

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

  fastify.get('/admin/editor', { ...guard }, async (_req, reply) => sendRetiredEditor(reply));
  // Preview keeps the legacy shell: the blocks editor links to
  // /admin/view/:slug and the slug-independent shell renders it. The
  // bundle reads the slug from the path, so one cached copy serves
  // every post.
  fastify.get('/admin/view/:slug', { ...guard }, async (_req, reply) => sendShell(reply));
}
