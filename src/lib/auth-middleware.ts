// Fastify hook that resolves the session cookie to a user and attaches
// it to the request. `requireUser` is the per-route guard that returns
// 401 when no user is present.

import cookiePlugin from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE_NAME } from '../routes/auth.ts';
import type { Db } from './db.ts';
import { readSessionUser, touchSession } from './sessions.ts';
import { touchLastSeen, type User } from './users.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

export async function registerAuthMiddleware(app: FastifyInstance, db: Db): Promise<void> {
  // Register the cookie plugin FIRST so its onRequest parser runs before
  // ours; otherwise req.cookies would be undefined here.
  if (!app.hasReplyDecorator('setCookie')) {
    await app.register(cookiePlugin);
  }

  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req) => {
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
