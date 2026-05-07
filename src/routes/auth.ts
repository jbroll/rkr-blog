// Social-login routes (Google only for now). See spec §17.
//
//   GET  /admin/auth/google/start    → redirect to Google's consent page
//   GET  /admin/auth/google/callback → exchange code, create session, redirect
//   POST /admin/logout               → destroy session, clear cookie

import cookiePlugin from '@fastify/cookie';
import { Google, generateCodeVerifier, generateState, type OAuth2Tokens } from 'arctic';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Db } from '../lib/db.ts';
import { type IdTokenVerifier, makeGoogleVerifier } from '../lib/google-jwt.ts';
import { createSession, deleteSession } from '../lib/sessions.ts';
import {
  EmailLinkedError,
  findOrCreateOAuthUser,
  NotInvitedError,
  type User
} from '../lib/users.ts';

const SESSION_COOKIE = 'rkr_session';
const OAUTH_STATE_COOKIE = 'rkr_oauth_state';
const OAUTH_STATE_TTL_S = 600;

// Decoded payload of a Google ID token. Fields per OpenID Connect spec.
export interface GoogleIdPayload {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
}

/**
 * Pluggable token-exchange so tests don't need to hit Google's servers.
 * Production wiring uses arctic; tests pass a stub that returns canned data.
 */
export interface TokenExchange {
  exchange(code: string, codeVerifier: string): Promise<OAuth2Tokens>;
  authorizationUrl(state: string, codeVerifier: string, scopes: string[]): URL;
}

export interface AuthRoutesOpts {
  db: Db;
  /** Production exchange uses arctic.Google. Tests inject a stub. */
  exchange?: TokenExchange;
  /** Production verifier hits Google's JWKS endpoint. Tests inject a stub. */
  verifier?: IdTokenVerifier;
  /** When set, the post-login redirect goes here (default /admin/editor). */
  postLoginPath?: string;
  /** Use Secure cookie attribute (true in prod over TLS). Default true. */
  secureCookies?: boolean;
}

export default async function authRoutes(
  fastify: FastifyInstance,
  opts: AuthRoutesOpts
): Promise<void> {
  const { db, postLoginPath = '/admin/editor', secureCookies = true } = opts;
  const exchange = opts.exchange ?? makeGoogleExchange();
  const verifier =
    opts.verifier ??
    /* c8 ignore next -- prod-only wiring; tests inject the verifier */
    makeGoogleVerifier(process.env.GOOGLE_CLIENT_ID ?? '');

  // Cookie plugin (idempotent — safe to register twice). Without an
  // explicit secret we get unsigned cookies, which is fine for our session
  // and oauth-state cookies (the values are random tokens; signing adds
  // nothing here).
  if (!fastify.hasReplyDecorator('setCookie')) {
    await fastify.register(cookiePlugin);
  }

  fastify.get(
    '/admin/auth/google/start',
    {
      // Cap login-start bursts per IP — defense against probing /admin
      // paths or churning OAuth state cookies. 30/min is very generous
      // for a real user.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
    },
    async (_req, reply) => {
      const state = generateState();
      const codeVerifier = generateCodeVerifier();
      const url = exchange.authorizationUrl(state, codeVerifier, ['openid', 'profile', 'email']);

      setCookie(reply, OAUTH_STATE_COOKIE, JSON.stringify({ state, codeVerifier }), {
        maxAge: OAUTH_STATE_TTL_S,
        secure: secureCookies
      });
      return reply.redirect(url.toString(), 302);
    }
  );

  fastify.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/admin/auth/google/callback',
    async (req, reply) => {
      if (req.query.error) {
        return reply.code(400).send({ error: `provider error: ${req.query.error}` });
      }
      const code = req.query.code;
      const incomingState = req.query.state;
      if (typeof code !== 'string' || typeof incomingState !== 'string') {
        return reply.code(400).send({ error: 'missing code or state' });
      }
      const cookieRaw = readCookie(req, OAUTH_STATE_COOKIE);
      if (!cookieRaw) return reply.code(400).send({ error: 'no oauth state cookie' });

      let parsed: { state: string; codeVerifier: string };
      try {
        parsed = JSON.parse(cookieRaw);
      } catch {
        return reply.code(400).send({ error: 'malformed oauth state cookie' });
      }
      if (parsed.state !== incomingState) {
        return reply.code(400).send({ error: 'oauth state mismatch' });
      }
      clearCookie(reply, OAUTH_STATE_COOKIE, { secure: secureCookies });

      let tokens: OAuth2Tokens;
      try {
        tokens = await exchange.exchange(code, parsed.codeVerifier);
      } catch (err) {
        req.log.warn({ err }, 'token exchange failed');
        return reply.code(400).send({ error: 'token exchange failed' });
      }

      const idToken = tokens.idToken();
      let payload: GoogleIdPayload;
      try {
        payload = await verifier.verify(idToken);
      } catch (err) {
        req.log.warn({ err }, 'id token verification failed');
        return reply.code(400).send({ error: 'invalid id token' });
      }

      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
        return reply.code(400).send({ error: 'id token missing sub or email' });
      }
      if (payload.email_verified === false) {
        return reply.code(403).send({ error: 'email not verified' });
      }

      let user: User;
      try {
        user = findOrCreateOAuthUser(db, {
          provider: 'google',
          sub: payload.sub,
          email: payload.email,
          displayName: payload.name ?? null
        });
      } catch (err) {
        if (err instanceof NotInvitedError || err instanceof EmailLinkedError) {
          return reply.code(403).send({ error: err.message });
        }
        /* c8 ignore next -- defensive: only NotInvitedError/EmailLinkedError thrown by name */
        throw err;
      }

      const ip = req.ip ?? null;
      const userAgent = req.headers['user-agent'] ?? null;
      const session = createSession(db, { userId: user.id, ip, userAgent });

      setCookie(reply, SESSION_COOKIE, session.id, {
        maxAge: Math.floor((Date.parse(session.expires_at) - Date.now()) / 1000),
        secure: secureCookies
      });

      return reply.redirect(postLoginPath, 302);
    }
  );

  fastify.post('/admin/logout', async (req, reply) => {
    const sid = readCookie(req, SESSION_COOKIE);
    if (sid) deleteSession(db, sid);
    clearCookie(reply, SESSION_COOKIE, { secure: secureCookies });
    return reply.redirect('/', 302);
  });
}

// ---- helpers -----------------------------------------------------------

interface CookieAttrs {
  maxAge: number;
  secure: boolean;
}

function setCookie(reply: FastifyReply, name: string, value: string, attrs: CookieAttrs): void {
  reply.setCookie(name, value, {
    httpOnly: true,
    secure: attrs.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: attrs.maxAge
  });
}

function clearCookie(reply: FastifyReply, name: string, attrs: { secure: boolean }): void {
  reply.clearCookie(name, {
    httpOnly: true,
    secure: attrs.secure,
    sameSite: 'lax',
    path: '/'
  });
}

function readCookie(req: FastifyRequest, name: string): string | undefined {
  return (req.cookies as Record<string, string | undefined> | undefined)?.[name];
}

/* c8 ignore start -- production-only wiring; tests inject a stub TokenExchange */
function makeGoogleExchange(): TokenExchange {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const baseUrl = process.env.PUBLIC_BASE_URL;
  if (!clientId || !clientSecret || !baseUrl) {
    throw new Error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and PUBLIC_BASE_URL must be set');
  }
  const redirectURI = new URL('/admin/auth/google/callback', baseUrl).toString();
  const google = new Google(clientId, clientSecret, redirectURI);
  return {
    authorizationUrl(state, codeVerifier, scopes) {
      return google.createAuthorizationURL(state, codeVerifier, scopes);
    },
    exchange(code, codeVerifier) {
      return google.validateAuthorizationCode(code, codeVerifier);
    }
  };
}
/* c8 ignore stop */

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
