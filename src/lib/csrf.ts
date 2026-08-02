// CSRF defense via Origin/Referer header validation.
//
// Cookie-authenticated state-changing requests must originate from one
// of the allowed origins. SameSite=Lax already blocks most cross-site
// POSTs at the browser layer; this is defense-in-depth for subdomain
// confusion, browser bugs, and clients that downgrade to no-SameSite.
//
// State-safe methods (GET, HEAD, OPTIONS) are not checked — those are
// not supposed to mutate state and the OAuth callback uses GET.
//
// Production wiring derives its origins from ADMIN_BASE_URL and
// PUBLIC_BASE_URL. They are the same origin unless the deployment splits
// its hostnames, in which case the reader origin is confined to paths
// outside /admin.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { adminTokenMatchesEnv } from './admin-token.ts';
import { parseBearerToken } from './bearer.ts';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface CsrfOptions {
  /** Origins that may initiate state-changing requests. e.g. ['https://example.com'] */
  allowedOrigins: string[];
  /**
   * Origins confined to the reader-facing surface: allowed everywhere
   * except under /admin. Set only when a deployment serves readers and
   * the admin from different hostnames — otherwise a page on the reader
   * host (a comment body, say) could forge an admin POST, and a shared
   * registrable domain means SameSite=Lax won't stop it either.
   */
  publicOnlyOrigins?: string[];
}

/**
 * Register an onRequest hook that 403s any state-changing request whose
 * Origin (or Referer when Origin is absent) doesn't match an allowed
 * origin. No-op for safe methods.
 */
export function registerCsrfGuard(app: FastifyInstance, opts: CsrfOptions): void {
  const allowed = new Set(opts.allowedOrigins.map(normaliseOrigin).filter(Boolean) as string[]);
  const publicOnly = new Set(
    (opts.publicOnlyOrigins ?? []).map(normaliseOrigin).filter(Boolean) as string[]
  );
  if (allowed.size === 0) {
    // Misconfiguration: registering with no origins would block every
    // POST, which is almost certainly not what the caller wants. Throw
    // at registration so it's obvious in startup logs.
    throw new Error('registerCsrfGuard requires at least one allowed origin');
  }

  app.addHook('onRequest', async (request, reply) => {
    if (!STATE_CHANGING.has(request.method)) return;

    // Bearer-token clients (the WP importer, scripted admin tools)
    // don't carry cookies, so the CSRF threat (a browser auto-attaching
    // a session cookie to a forged cross-origin POST) doesn't apply.
    // Skip the Origin check only when the bearer token is actually the
    // configured ADMIN_TOKEN. Any other Authorization value (wrong token,
    // junk header) still goes through the full CSRF check — a browser
    // cannot bypass Origin validation by sending a fake bearer header.
    const bearer = parseBearerToken(request.headers.authorization);
    if (bearer !== undefined && adminTokenMatchesEnv(bearer)) {
      return;
    }

    const claimed = pickClaimedOrigin(request);
    if (claimed === null) {
      reply.code(403).send({ error: 'cross-origin request blocked: missing Origin/Referer' });
      return reply;
    }
    if (allowed.has(claimed)) return;
    if (publicOnly.has(claimed) && !isAdminPath(request.url)) return;
    reply.code(403).send({ error: `cross-origin request blocked: ${claimed}` });
    return reply;
  });
}

/** Whether a raw request URL targets the admin surface. Collapses repeated
 * slashes and lowercases before matching: Fastify's router would 404 those
 * variants anyway, and erring toward "admin" only ever tightens the check. */
function isAdminPath(rawUrl: string): boolean {
  const path = (rawUrl.split(/[?#]/)[0] ?? '').replace(/\/{2,}/g, '/').toLowerCase();
  return path === '/admin' || path.startsWith('/admin/');
}

function pickClaimedOrigin(request: FastifyRequest): string | null {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') {
    return normaliseOrigin(origin);
  }
  // Fallback to Referer (some browsers strip Origin on same-origin GETs;
  // not strictly applicable to POST but kept defensive).
  const referer = request.headers.referer;
  if (typeof referer === 'string' && referer.length > 0) {
    try {
      return normaliseOrigin(new URL(referer).origin);
    } catch {
      return null;
    }
  }
  return null;
}

function normaliseOrigin(s: string): string {
  // Lowercase scheme+host, strip default port. URL handles all of this
  // cleanly via .origin, but the input may already be a bare origin.
  try {
    return new URL(s).origin;
  } catch {
    return '';
  }
}
