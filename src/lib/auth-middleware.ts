// Fastify hook that resolves the session cookie to a user and attaches
// it to the request. `requireUser` is the per-route guard that returns
// 401 when no user is present.
//
// Bearer-token path: when the env var ADMIN_TOKEN is set and a request
// arrives with `Authorization: Bearer <ADMIN_TOKEN>`, we attach a
// synthetic admin user (id=0, role=owner). This is for scripted
// clients (the WordPress importer; future migration tooling). The
// token is matched with timingSafeEqual to keep the comparison from
// leaking length/prefix info under timing analysis.

import cookiePlugin from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { adminTokenMatchesEnv } from './admin-token.ts';
import type { Db } from './db.ts';
import { clearFailures, isThrottled, recordFailure, WINDOW_MS } from './login-throttle.ts';
import { SESSION_COOKIE_NAME } from './session-constants.ts';
import { readSessionUser, touchSession } from './sessions.ts';
import { touchLastSeen, type User } from './users.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

const BEARER_USER: User = {
  id: 0,
  email: 'bearer-token@local',
  display_name: 'admin (bearer token)',
  role: 'owner',
  created_at: '1970-01-01T00:00:00Z',
  last_seen_at: null
};

function bearerTokenFromHeader(req: FastifyRequest): string | undefined {
  const raw = req.headers.authorization;
  if (!raw) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m?.[1]?.trim();
}

export async function registerAuthMiddleware(app: FastifyInstance, db: Db): Promise<void> {
  // Register the cookie plugin FIRST so its onRequest parser runs before
  // ours; otherwise req.cookies would be undefined here.
  if (!app.hasReplyDecorator('setCookie')) {
    await app.register(cookiePlugin);
  }

  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req, reply) => {
    // Bearer-token path takes precedence over the cookie path. A
    // request that supplies both is treated as a bearer client (the
    // typical case is a script that doesn't carry cookies anyway).
    const bearer = bearerTokenFromHeader(req);
    if (bearer !== undefined) {
      // The bearer path is CSRF-exempt and otherwise unthrottled, so
      // without this an attacker could brute-force ADMIN_TOKEN against
      // any /admin/* mutating route. Share the per-IP failed-credential
      // tally with the browser token-login route so the ceiling can't
      // be sidestepped by switching entry points.
      if (isThrottled(req.ip)) {
        reply
          .code(429)
          .header('retry-after', String(Math.ceil(WINDOW_MS / 1000)))
          .send({ error: 'too many failed login attempts' });
        return;
      }
      if (adminTokenMatchesEnv(bearer)) {
        req.user = BEARER_USER;
        // Clean success — drop any prior failure tally for this IP.
        clearFailures(req.ip);
      } else {
        // Wrong token is the brute-force signal; record it. The user
        // stays null and requireUser issues the existing 401 — only
        // the Nth+ miss within the window flips to 429 above.
        recordFailure(req.ip);
      }
      // Either the bearer matched (user attached) or it didn't (user
      // stays null and requireUser will 401). In both cases skip the
      // cookie path — a request that explicitly authenticates with a
      // bearer header should not silently fall through to a cookie
      // session, which would mask token-rotation bugs.
      return;
    }

    const sid = (req.cookies as Record<string, string | undefined> | undefined)?.[
      SESSION_COOKIE_NAME
    ];
    if (!sid) return;
    const result = readSessionUser(db, sid);
    if (!result) return;
    req.user = result.user;
    // Sliding session: touch last_seen_at on each authenticated request.
    const now = new Date().toISOString();
    touchSession(db, result.session.id, now);
    touchLastSeen(db, result.user.id, now);
  });
}

/**
 * preHandler that 401s if no user is present. Use on `/admin/*` routes
 * that should not be reachable without a session.
 */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) {
    reply.code(401).send({ error: 'authentication required' });
  }
}

// requireOwner will land alongside the first owner-only route (likely the
// user-management UI). Removed for now to keep coverage honest.
