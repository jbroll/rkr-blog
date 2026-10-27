// Security headers for public pages and the admin block editor. Both
// share the same header set; only img-src differs: public pages keep
// the tighter `'self' data:`, while the editor adds `blob:` for its
// canvas previews. Kept in one place so the CSP and the header set
// can't drift between the public happy path, the editor, and the
// global not-found / error handlers in src/server.ts.
//
// CSP is intentionally tight: posts don't need third-party scripts,
// images, or styles. The site-wide JS (lightbox + carousel) is
// bundled and served from /static. The markdown renderer passes
// through raw HTML in posts (single-author trust); CSP+nosniff
// narrow the blast radius if a content mistake or future
// external-import path lets something through.

import type { FastifyReply } from 'fastify';

import { EMBED_FRAME_SRC } from './embed-allow.ts';

/** Build the CSP string around an image-source allowlist. Public pages
 * get `'self' data:`; the block editor additionally needs `blob:` for
 * its client-side canvas previews (canvasToBlob → object URL). Every
 * other directive is identical. */
function buildCsp(imgSrc: string): string {
  return [
    "default-src 'self'",
    `img-src ${imgSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-src ${EMBED_FRAME_SRC}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'"
  ].join('; ');
}

const PUBLIC_CSP = buildCsp("'self' data:");
// Cloud picker thumbnails (Drive and Photos from googleusercontent,
// OneDrive from 1drv / svc.ms). Only the editor page gets these.
const ADMIN_EDITOR_CSP = buildCsp(
  "'self' data: blob: https://*.googleusercontent.com https://*.1drv.com https://*.onedrive.live.com https://*.svc.ms"
);

function setSecurityHeaders(reply: FastifyReply, csp: string): void {
  reply.header('Content-Security-Policy', csp);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  // X-Frame-Options is redundant with frame-ancestors for modern
  // browsers but cheap insurance for old crawlers + WAF heuristics.
  reply.header('X-Frame-Options', 'DENY');
}

export function setPublicSecurityHeaders(reply: FastifyReply): void {
  setSecurityHeaders(reply, PUBLIC_CSP);
}

/** Same header set as the public pages, but img-src adds `blob:` and the
 * cloud picker thumbnail hosts.
 * Only the unified block editor needs it: canvas-loaders draws the
 * original into a canvas and points `<img>` at the resulting object
 * URL, which Chromium refuses to decode under the public CSP. */
export function setAdminEditorSecurityHeaders(reply: FastifyReply): void {
  setSecurityHeaders(reply, ADMIN_EDITOR_CSP);
}
