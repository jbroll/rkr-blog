// Retired editor URLs. /admin/editor answers 404 with a pointer to the
// blocks editor; /admin/view/:slug redirects to it, and its View mode
// replaced the old preview.

import type { FastifyInstance, FastifyReply, RouteShorthandOptions } from 'fastify';

import { setPublicSecurityHeaders } from '../lib/security-headers.ts';

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
  fastify.get('/admin/editor', { ...guard }, async (_req, reply) => sendRetiredEditor(reply));
  fastify.get<{ Params: { slug: string } }>('/admin/view/:slug', { ...guard }, async (req, reply) =>
    reply
      .code(302)
      .header('location', `/admin/blocks/edit/${encodeURIComponent(req.params.slug)}`)
      .send()
  );
}
