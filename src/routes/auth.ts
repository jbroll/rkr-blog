// Social-login routes (Google only for now). See spec.md §13 auth.
//
//   GET  /admin/auth/google/start    → redirect to Google's consent page
//   GET  /admin/auth/google/callback → exchange code, create session, redirect
//   POST /admin/logout               → destroy session, clear cookie

import cookiePlugin from '@fastify/cookie';
import { Google, generateCodeVerifier, generateState, type OAuth2Tokens } from 'arctic';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { adminTokenMatchesEnv } from '../lib/admin-token.ts';
import type { Db } from '../lib/db.ts';
import {
  type GoogleIdPayload,
  type IdTokenVerifier,
  makeGoogleVerifier
} from '../lib/google-jwt.ts';
import { createSession, deleteSession } from '../lib/sessions.ts';
import {
  EmailLinkedError,
  findOrCreateOAuthUser,
  findOrCreateTokenAdmin,
  NotInvitedError,
  type User
} from '../lib/users.ts';

const SESSION_COOKIE = 'rkr_session';
const OAUTH_STATE_COOKIE = 'rkr_oauth_state';
const OAUTH_STATE_TTL_S = 600;

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

  // PKCE verifier is stored server-side, keyed by state, NOT in the
  // client cookie. PKCE's threat model assumes the verifier never leaves
  // the server; storing it in a (HttpOnly) cookie made it round-trip
  // through the browser, which defeats the original purpose. This map
  // is in-process; multi-process deployments would need a DB-backed or
  // Redis-backed store.
  const pendingFlows = new Map<string, { codeVerifier: string; expiresAt: number }>();

  function rememberFlow(state: string, codeVerifier: string): void {
    sweepExpiredFlows();
    pendingFlows.set(state, {
      codeVerifier,
      expiresAt: Date.now() + OAUTH_STATE_TTL_S * 1000
    });
  }

  function takeFlow(state: string): string | null {
    sweepExpiredFlows();
    const entry = pendingFlows.get(state);
    if (!entry) return null;
    pendingFlows.delete(state);
    return entry.codeVerifier;
  }

  function sweepExpiredFlows(): void {
    const now = Date.now();
    for (const [k, v] of pendingFlows) {
      if (v.expiresAt < now) pendingFlows.delete(k);
    }
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

      rememberFlow(state, codeVerifier);
      // The cookie now holds only the state — the verifier stays on the
      // server. Cookie still required so the callback can prove the same
      // browser initiated the flow (CSRF protection on the OAuth dance).
      setCookie(reply, OAUTH_STATE_COOKIE, state, {
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
      const stateCookie = readCookie(req, OAUTH_STATE_COOKIE);
      if (!stateCookie) return reply.code(400).send({ error: 'no oauth state cookie' });
      if (stateCookie !== incomingState) {
        return reply.code(400).send({ error: 'oauth state mismatch' });
      }
      clearCookie(reply, OAUTH_STATE_COOKIE, { secure: secureCookies });

      const codeVerifier = takeFlow(incomingState);
      if (!codeVerifier) {
        return reply.code(400).send({ error: 'oauth flow expired or unknown' });
      }

      let tokens: OAuth2Tokens;
      try {
        tokens = await exchange.exchange(code, codeVerifier);
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

  // ---- token-login (browser flow) -------------------------------------
  // Lets the operator log in via the browser using the ADMIN_TOKEN env
  // var as a password. Mints a normal session cookie on the same code
  // path Google OAuth uses; the synthetic admin user lives in the DB
  // (findOrCreateTokenAdmin) so sessions.user_id FK holds.
  //
  // The bearer-header path (auth-middleware.ts) remains for stateless
  // CLI clients; this is the addition for human browser use.

  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const params = new URLSearchParams(body as string);
        done(null, Object.fromEntries(params));
      } catch (err) {
        /* c8 ignore next 2 -- URLSearchParams accepts almost any string */
        done(err as Error, undefined);
      }
    }
  );

  fastify.get('/admin/login', async (_req, reply) => {
    const adminTokenAvailable = !!process.env.ADMIN_TOKEN;
    return reply.type('text/html; charset=utf-8').send(renderLoginPage({ adminTokenAvailable }));
  });

  fastify.post<{ Body: { token?: string } }>(
    '/admin/auth/token-login',
    {
      // Aggressive rate limit — auth endpoint with brute-force exposure.
      // ADMIN_TOKEN is long-random so brute force is infeasible, but the
      // limit keeps attempt logs sparse and observable.
      config: { rateLimit: { max: 5, timeWindow: '5 minutes' } }
    },
    async (req, reply) => {
      const provided = typeof req.body?.token === 'string' ? req.body.token : '';
      if (!provided) {
        req.log.warn({ ip: req.ip, ua: req.headers['user-agent'] }, 'token-login: empty token');
        return reply.code(400).send({ error: 'token required' });
      }
      if (!process.env.ADMIN_TOKEN) {
        req.log.warn({ ip: req.ip }, 'token-login: ADMIN_TOKEN not configured');
        return reply.code(503).send({ error: 'token login not configured' });
      }
      if (!adminTokenMatchesEnv(provided)) {
        req.log.warn({ ip: req.ip, ua: req.headers['user-agent'] }, 'token-login: token mismatch');
        return reply.code(401).send({ error: 'invalid token' });
      }

      const user = findOrCreateTokenAdmin(db);
      const ip = req.ip ?? null;
      const userAgent = req.headers['user-agent'] ?? null;
      const session = createSession(db, { userId: user.id, ip, userAgent });
      setCookie(reply, SESSION_COOKIE, session.id, {
        maxAge: Math.floor((Date.parse(session.expires_at) - Date.now()) / 1000),
        secure: secureCookies
      });
      req.log.info({ userId: user.id, ip }, 'token-login: success');
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

function renderLoginPage(opts: { adminTokenAvailable: boolean }): string {
  const tokenForm = opts.adminTokenAvailable
    ? `<form method="post" action="/admin/auth/token-login" class="rkr-login-form">
  <label>Admin token<input type="password" name="token" autocomplete="current-password" required/></label>
  <button type="submit">Sign in with token</button>
</form>`
    : '<p class="rkr-login-hint">Token login disabled (ADMIN_TOKEN not set).</p>';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sign in — rkroll admin</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; }
  h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
  .rkr-login-google { display: inline-block; padding: 0.5rem 1rem; border: 1px solid #888; border-radius: 4px; text-decoration: none; color: inherit; }
  .rkr-login-form { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 2rem; }
  .rkr-login-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; }
  .rkr-login-form input { padding: 0.5rem; font: inherit; border: 1px solid #aaa; border-radius: 4px; }
  .rkr-login-form button { padding: 0.5rem 1rem; font: inherit; cursor: pointer; }
  .rkr-login-hint { color: #666; font-size: 0.9rem; margin-top: 2rem; }
  hr { border: none; border-top: 1px solid #ddd; margin: 2rem 0; }
</style>
</head>
<body>
<h1>Sign in to admin</h1>
<a class="rkr-login-google" href="/admin/auth/google/start">Sign in with Google</a>
<hr/>
${tokenForm}
</body>
</html>`;
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
