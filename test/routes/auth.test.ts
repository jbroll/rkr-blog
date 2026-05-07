import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import type { IdTokenVerifier } from '../../src/lib/google-jwt.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { findUserByEmail, inviteEmail } from '../../src/lib/users.ts';
import type { GoogleIdPayload, TokenExchange } from '../../src/routes/auth.ts';
import { buildApp } from '../../src/server.ts';

interface ErrorBody {
  error: string;
}

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-auth-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'data', 'content/posts']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeIdToken(payload: Record<string, unknown>): string {
  // We never verify the signature; just produce a well-formed JWT shape.
  const header = Buffer.from('{"alg":"none"}').toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

interface StubExchangeOpts {
  idTokenPayload: Record<string, unknown>;
  /** Override the authorization URL emitted by /start. */
  authorizationUrl?: string;
  /** When true, the stub verifier rejects (simulates a forged/invalid token). */
  verifierRejects?: boolean;
}

function stubExchange(opts: StubExchangeOpts): TokenExchange {
  const url = opts.authorizationUrl ?? 'https://accounts.google.com/test/authorize';
  return {
    authorizationUrl(state) {
      const u = new URL(url);
      u.searchParams.set('state', state);
      return u;
    },
    async exchange() {
      const idToken = makeIdToken(opts.idTokenPayload);
      // arctic's OAuth2Tokens has an `idToken()` method; we mimic just that.
      return {
        idToken: () => idToken,
        accessToken: () => 'fake-access',
        accessTokenExpiresAt: () => new Date(Date.now() + 3600 * 1000),
        accessTokenExpiresInSeconds: () => 3600,
        hasRefreshToken: () => false,
        hasScopes: () => false,
        refreshToken: () => '',
        scopes: () => [],
        tokenType: () => 'Bearer',
        data: {}
      };
    }
  };
}

/** Stub verifier paired with stubExchange — yields the same payload the
 * exchange used for the id token, or rejects if the test wants to simulate
 * an invalid signature / aud / iss. Production verifies via Google JWKS. */
function stubVerifier(opts: StubExchangeOpts): IdTokenVerifier {
  return {
    async verify() {
      if (opts.verifierRejects) {
        throw new Error('signature mismatch (stub)');
      }
      return opts.idTokenPayload as unknown as GoogleIdPayload;
    }
  };
}

async function setup(
  t: TestContext,
  opts: StubExchangeOpts
): Promise<{
  root: string;
  db: ReturnType<typeof open>;
  app: Awaited<ReturnType<typeof buildApp>>;
}> {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: {
      exchange: stubExchange(opts),
      verifier: stubVerifier(opts),
      secureCookies: false
    }
  });
  t.after(() => app.close());
  return { root, db, app };
}

// ---- /admin/auth/google/start -----------------------------------------

test('GET /admin/auth/google/start redirects to provider with state in URL + cookie', async (t) => {
  const { app } = await setup(t, { idTokenPayload: {} });
  const res = await app.inject({ method: 'GET', url: '/admin/auth/google/start' });
  assert.equal(res.statusCode, 302);

  const location = res.headers.location as string;
  assert.match(location, /^https:\/\/accounts\.google\.com\/test\/authorize/);
  const state = new URL(location).searchParams.get('state');
  assert.ok(state, 'state in URL');

  const setCookie = res.headers['set-cookie'] as string | string[];
  const stateCookie = ([] as string[])
    .concat(setCookie)
    .find((c) => c.startsWith('rkr_oauth_state='));
  assert.ok(stateCookie, 'state cookie set');
});

// ---- /admin/auth/google/callback (happy paths) -------------------------

test('callback: bootstrap user (no users yet) becomes owner', async (t) => {
  const { db, app } = await setup(t, {
    idTokenPayload: { sub: 'g-1', email: 'first@example.com', name: 'First', email_verified: true }
  });

  // Drive the state cookie ourselves rather than wiring two requests.
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  const res = await app.inject({
    method: 'GET',
    url: '/admin/auth/google/callback?code=abc&state=st',
    headers: { cookie: `rkr_oauth_state=${stateCookie}` }
  });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/admin/editor');

  const user = findUserByEmail(db, 'first@example.com');
  assert.ok(user);
  assert.equal(user?.role, 'owner');

  const setCookie = res.headers['set-cookie'] as string | string[];
  const cookies = ([] as string[]).concat(setCookie);
  assert.ok(cookies.some((c) => c.startsWith('rkr_session=')));
});

test('callback: invited email logs in successfully (uses invite role)', async (t) => {
  const { db, app } = await setup(t, {
    idTokenPayload: { sub: 'g-2', email: 'editor@example.com', email_verified: true }
  });
  // Bootstrap so the system has at least one user — forces allowlist check.
  db.prepare(
    `INSERT INTO users (email, display_name, role, created_at)
     VALUES (?, NULL, 'owner', ?)`
  ).run('owner@example.com', new Date().toISOString());
  inviteEmail(db, 'editor@example.com', 'editor');

  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  const res = await app.inject({
    method: 'GET',
    url: '/admin/auth/google/callback?code=c&state=st',
    headers: { cookie: `rkr_oauth_state=${stateCookie}` }
  });
  assert.equal(res.statusCode, 302);
  assert.equal(findUserByEmail(db, 'editor@example.com')?.role, 'editor');
});

// ---- /admin/auth/google/callback (failure paths) -----------------------

test('callback: state mismatch → 400', async (t) => {
  const { app } = await setup(t, {
    idTokenPayload: { sub: 'g-1', email: 'a@x.com', email_verified: true }
  });
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'expected', codeVerifier: 'cv' }));
  const res = await app.inject({
    method: 'GET',
    url: '/admin/auth/google/callback?code=c&state=different',
    headers: { cookie: `rkr_oauth_state=${stateCookie}` }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /state mismatch/);
});

test('callback: missing state cookie → 400', async (t) => {
  const { app } = await setup(t, {
    idTokenPayload: { sub: 'g-1', email: 'a@x.com', email_verified: true }
  });
  const res = await app.inject({
    method: 'GET',
    url: '/admin/auth/google/callback?code=c&state=st'
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /no oauth state cookie/);
});

test('callback: id token signature/aud/iss verification failure → 400', async (t) => {
  // A forged token (or one for the wrong audience) is rejected by the
  // verifier before sub/email are even read. Without this guard, an
  // attacker who could intercept the exchange could mint a session for
  // any email address (the original critical finding).
  const { app } = await setup(t, {
    idTokenPayload: { sub: 'g-1', email: 'forger@evil.com', email_verified: true },
    verifierRejects: true
  });
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  const res = await app.inject({
    method: 'GET',
    url: '/admin/auth/google/callback?code=c&state=st',
    headers: { cookie: `rkr_oauth_state=${stateCookie}` }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /invalid id token/);
});

test('callback: id token missing sub or email → 400', async (t) => {
  const { app } = await setup(t, { idTokenPayload: { email: 'a@x.com' } /* no sub */ });
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  const res = await app.inject({
    method: 'GET',
    url: '/admin/auth/google/callback?code=c&state=st',
    headers: { cookie: `rkr_oauth_state=${stateCookie}` }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /missing sub or email/);
});

test('callback: provider error parameter → 400', async (t) => {
  const { app } = await setup(t, { idTokenPayload: {} });
  const res = await app.inject({
    method: 'GET',
    url: '/admin/auth/google/callback?error=access_denied'
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /provider error/);
});

test('callback: email_verified=false → 403', async (t) => {
  const { app } = await setup(t, {
    idTokenPayload: { sub: 'g-1', email: 'a@x.com', email_verified: false }
  });
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  const res = await app.inject({
    method: 'GET',
    url: '/admin/auth/google/callback?code=c&state=st',
    headers: { cookie: `rkr_oauth_state=${stateCookie}` }
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json<ErrorBody>().error, /email not verified/);
});

test('callback: not-invited email after bootstrap → 403', async (t) => {
  const { db, app } = await setup(t, {
    idTokenPayload: { sub: 'g-2', email: 'stranger@x.com', email_verified: true }
  });
  db.prepare(
    `INSERT INTO users (email, display_name, role, created_at) VALUES (?, NULL, 'owner', ?)`
  ).run('owner@x.com', new Date().toISOString());

  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  const res = await app.inject({
    method: 'GET',
    url: '/admin/auth/google/callback?code=c&state=st',
    headers: { cookie: `rkr_oauth_state=${stateCookie}` }
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json<ErrorBody>().error, /not invited/);
});

// ---- /admin/logout ----------------------------------------------------

test('POST /admin/logout clears the session cookie', async (t) => {
  const { app } = await setup(t, { idTokenPayload: {} });
  const res = await app.inject({
    method: 'POST',
    url: '/admin/logout',
    headers: { cookie: 'rkr_session=anything' }
  });
  assert.equal(res.statusCode, 302);
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] as string | string[]);
  assert.ok(setCookie.some((c) => c.startsWith('rkr_session=') && /Max-Age=0|Expires=/.test(c)));
});

// ---- CSRF (Origin/Referer guard, when allowedOrigins is configured) -----

test('POST /admin/logout 403s on a cross-origin request when CSRF is wired', async (t) => {
  // Build an app with allowedOrigins set — this is what production
  // startServer does when PUBLIC_BASE_URL is configured.
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: {
      exchange: stubExchange({ idTokenPayload: {} }),
      verifier: stubVerifier({ idTokenPayload: {} }),
      secureCookies: false,
      allowedOrigins: ['http://localhost']
    }
  });
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/admin/logout',
    headers: {
      cookie: 'rkr_session=anything',
      origin: 'https://attacker.example'
    }
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json<ErrorBody>().error, /cross-origin/);
});

// ---- /admin/* gating ---------------------------------------------------

test('GET /admin/editor 401s without a session cookie', async (t) => {
  const { app } = await setup(t, { idTokenPayload: {} });
  const res = await app.inject({ method: 'GET', url: '/admin/editor' });
  assert.equal(res.statusCode, 401);
});

test('GET /admin/editor succeeds with a valid session cookie', async (t) => {
  const { db, app } = await setup(t, {
    idTokenPayload: { sub: 'g-1', email: 'first@example.com', email_verified: true }
  });

  // Sign in via the callback to mint a real session.
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  const cb = await app.inject({
    method: 'GET',
    url: '/admin/auth/google/callback?code=c&state=st',
    headers: { cookie: `rkr_oauth_state=${stateCookie}` }
  });
  assert.equal(cb.statusCode, 302);
  const sessionCookie = ([] as string[])
    .concat(cb.headers['set-cookie'] as string | string[])
    .find((c) => c.startsWith('rkr_session='));
  assert.ok(sessionCookie);
  const sid = (sessionCookie ?? '').split(';')[0]?.split('=')[1] ?? '';
  // Sanity check: the session row exists in the db with this id.
  assert.ok(
    db.prepare('SELECT id FROM sessions WHERE id = ?').get(sid),
    `expected session ${sid} to exist`
  );

  const res = await app.inject({
    method: 'GET',
    url: '/admin/editor',
    headers: { cookie: `rkr_session=${sid}` }
  });
  assert.equal(res.statusCode, 200, `body=${res.body}`);
  assert.match(res.body, /<div id="rkroll-admin-root"/);

  // Sanity: session and user actually exist in the db.
  assert.ok(findUserByEmail(db, 'first@example.com'));
});
