// Public-page security headers, shared by the public route plugins
// (src/routes/public.ts, src/routes/public-img.ts) and the global
// not-found / error handlers in src/server.ts. Kept in one place so
// the CSP and the header set can't drift between the happy path and
// the error/404 chokepoint.
//
// CSP is intentionally tight: posts don't need third-party scripts,
// images, or styles. The site-wide JS (lightbox + carousel) is
// bundled and served from /static. The markdown renderer passes
// through raw HTML in posts (single-author trust); CSP+nosniff
// narrow the blast radius if a content mistake or future
// external-import path lets something through.

import type { FastifyReply } from 'fastify';

const PUBLIC_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join('; ');

export function setPublicSecurityHeaders(reply: FastifyReply): void {
  reply.header('Content-Security-Policy', PUBLIC_CSP);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  // X-Frame-Options is redundant with frame-ancestors for modern
  // browsers but cheap insurance for old crawlers + WAF heuristics.
  reply.header('X-Frame-Options', 'DENY');
}
