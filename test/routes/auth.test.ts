import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import type { GoogleIdPayload, IdTokenVerifier } from '../../src/lib/google-jwt.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { findUserByEmail, inviteEmail } from '../../src/lib/users.ts';
import type { TokenExchange } from '../../src/routes/auth.ts';
import { buildApp } from '../../src/server.ts';
import type { ErrorBody } from '../helpers/oauth-fixtures.ts';

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

/** Drive /admin/auth/google/start to seed the in-process PKCE state map.
 * Returns the state value and the cookie header to feed into /callback.
 * (PKCE verifier is now server-side, so direct callback hits are no
 * longer hermetic without going through /start first.) */
async function primeStartFlow(app: Awaited<ReturnType<typeof buildApp>>): Promise<{
  state: string;
  cookie: string;
}> {
  const res = await app.inject({ method: 'GET', url: '/admin/auth/google/start' });
  if (res.statusCode !== 302) {
    throw new Error(`expected 302 from /start, got ${res.statusCode}: ${res.body}`);
  }
  const setCookies = ([] as string[]).concat(res.headers['set-cookie'] as string | string[]);
  const stateCookieFull = setCookies.find((c) => c.startsWith('rkr_oauth_state=')) ?? '';
  const cookie = stateCookieFull.split(';')[0] ?? '';
  const state = new URL(res.headers.location as string).searchParams.get('state') ?? '';
  return { state, cookie };
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

test('callback: empty allowlist → 403 (operator must invite first)', async (t) => {
  // Removed the old "first login becomes owner" bypass. The operator
  // runs `site-admin user invite <email> --role=owner` before any
  // OAuth login can succeed. Without an entry, every login 403s —
  // closing the deployment-window takeover risk.
  const { db, app } = await setup(t, {
    idTokenPayload: {
      sub: 'g-1',
      email: 'first@example.com',
      name: 'First',
      email_verified: true
    }
  });

  const { state, cookie } = await primeStartFlow(app);
  const res = await app.inject({
    method: 'GET',
    url: `/admin/auth/google/callback?code=abc&state=${state}`,
    headers: { cookie }
  });
  assert.equal(res.statusCode, 403);
  assert.equal(findUserByEmail(db, 'first@example.com'), undefined);
});

test('callback: invited owner email is bootstrapped as owner', async (t) => {
  const { db, app } = await setup(t, {
    idTokenPayload: {
      sub: 'g-1',
      email: 'owner@example.com',
      name: 'Owner',
      email_verified: true
    }
  });
  inviteEmail(db, 'owner@example.com', 'owner');

  const { state, cookie } = await primeStartFlow(app);
  const res = await app.inject({
    method: 'GET',
    url: `/admin/auth/google/callback?code=abc&state=${state}`,
    headers: { cookie }
  });
  assert.equal(res.statusCode, 302);
  // Auth redirects append ?_rkr=login so the SW's SWR pages cache
  // can't serve a stale anonymous render for the new session — see
  // src/site/sw-register.ts for the page-side counterpart that
  // flushes the cache and strips the param.
  assert.equal(res.headers.location, '/?_rkr=login');

  const user = findUserByEmail(db, 'owner@example.com');
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

  const { state, cookie } = await primeStartFlow(app);
  const res = await app.inject({
    method: 'GET',
    url: `/admin/auth/google/callback?code=c&state=${state}`,
    headers: { cookie }
  });
  assert.equal(res.statusCode, 302);
  assert.equal(findUserByEmail(db, 'editor@example.com')?.role, 'editor');
});

// ---- /admin/auth/google/callback (failure paths) -----------------------

test('callback: state mismatch → 400', async (t) => {
  const { app } = await setup(t, {
    idTokenPayload: { sub: 'g-1', email: 'a@x.com', email_verified: true }
  });
  const { cookie } = await primeStartFlow(app);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/auth/google/callback?code=c&state=different-state-not-in-cookie',
    headers: { cookie }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /state mismatch/);
});

test('callback: state cookie matches but server-side flow is unknown → 400', async (t) => {
  // Defends the PKCE-off-cookie design: a cookie alone is no longer
  // sufficient — the verifier must also be in the in-process map. If
  // an attacker obtains/forges the cookie value but didn't drive /start
  // (or the entry expired), the callback fails before any token exchange.
  const { app } = await setup(t, {
    idTokenPayload: { sub: 'g-1', email: 'a@x.com', email_verified: true }
  });
  const res = await app.inject({
    method: 'GET',
    url: '/admin/auth/google/callback?code=c&state=ghost',
    headers: { cookie: 'rkr_oauth_state=ghost' }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /flow expired or unknown/);
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
  const { state, cookie } = await primeStartFlow(app);
  const res = await app.inject({
    method: 'GET',
    url: `/admin/auth/google/callback?code=c&state=${state}`,
    headers: { cookie }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /invalid id token/);
});

test('callback: id token missing sub or email → 400', async (t) => {
  const { app } = await setup(t, { idTokenPayload: { email: 'a@x.com' } /* no sub */ });
  const { state, cookie } = await primeStartFlow(app);
  const res = await app.inject({
    method: 'GET',
    url: `/admin/auth/google/callback?code=c&state=${state}`,
    headers: { cookie }
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
  const { state, cookie } = await primeStartFlow(app);
  const res = await app.inject({
    method: 'GET',
    url: `/admin/auth/google/callback?code=c&state=${state}`,
    headers: { cookie }
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

  const { state, cookie } = await primeStartFlow(app);
  const res = await app.inject({
    method: 'GET',
    url: `/admin/auth/google/callback?code=c&state=${state}`,
    headers: { cookie }
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
  assert.equal(res.headers.location, '/?_rkr=logout');
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
  inviteEmail(db, 'first@example.com', 'owner');

  // Sign in via the callback to mint a real session.
  const { state, cookie } = await primeStartFlow(app);
  const cb = await app.inject({
    method: 'GET',
    url: `/admin/auth/google/callback?code=c&state=${state}`,
    headers: { cookie }
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

// ---- token-login (browser) ---------------------------------------------

async function postTokenLogin(
  app: Awaited<ReturnType<typeof buildApp>>,
  token: string
): Promise<ReturnType<typeof app.inject> extends Promise<infer R> ? R : never> {
  return app.inject({
    method: 'POST',
    url: '/admin/auth/token-login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `token=${encodeURIComponent(token)}`
  });
}

test('GET /login renders the form when ADMIN_TOKEN is set', async (t) => {
  const orig = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'secret-token-value';
  t.after(() => {
    if (orig === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = orig;
  });
  const { app } = await setup(t, { idTokenPayload: {} });
  const res = await app.inject({ method: 'GET', url: '/login' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  assert.match(res.body, /<form method="post" action="\/admin\/auth\/token-login"/);
  assert.match(res.body, /Sign in with Google/);
});

test('GET /login hides the form when ADMIN_TOKEN is unset', async (t) => {
  const orig = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  t.after(() => {
    if (orig !== undefined) process.env.ADMIN_TOKEN = orig;
  });
  const { app } = await setup(t, { idTokenPayload: {} });
  const res = await app.inject({ method: 'GET', url: '/login' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Token login disabled/);
  assert.doesNotMatch(res.body, /<form/);
});

test('POST /admin/auth/token-login: correct token → session cookie + 302', async (t) => {
  const orig = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'right-token';
  t.after(() => {
    if (orig === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = orig;
  });
  const { db, app } = await setup(t, { idTokenPayload: {} });
  const res = await postTokenLogin(app, 'right-token');
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/?_rkr=login');

  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] as string | string[]);
  const sessionCookie = setCookie.find((c) => c.startsWith('rkr_session='));
  assert.ok(sessionCookie, 'session cookie set');
  const sid = (sessionCookie ?? '').split(';')[0]?.split('=')[1] ?? '';

  // The synthetic admin user exists in the db.
  const admin = findUserByEmail(db, 'admin@token.local');
  assert.ok(admin, 'token-admin user created');
  assert.equal(admin?.role, 'owner');
  // The session row points at the synthetic admin.
  const sess = db
    .prepare<{ user_id: number }>('SELECT user_id FROM sessions WHERE id = ?')
    .get(sid);
  assert.equal(sess?.user_id, admin?.id);
});

test('POST /admin/auth/token-login: wrong token → 401, no session', async (t) => {
  const orig = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'right-token';
  t.after(() => {
    if (orig === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = orig;
  });
  const { db, app } = await setup(t, { idTokenPayload: {} });
  const res = await postTokenLogin(app, 'wrong-token');
  assert.equal(res.statusCode, 401);
  assert.equal((res.json() as ErrorBody).error, 'invalid token');
  // No session cookie set.
  const setCookieRaw = res.headers['set-cookie'];
  const setCookie = setCookieRaw ? ([] as string[]).concat(setCookieRaw) : [];
  assert.ok(
    !setCookie.some((c) => c.startsWith('rkr_session=')),
    'no session cookie on failed login'
  );
  // No synthetic admin row created.
  assert.equal(findUserByEmail(db, 'admin@token.local'), undefined);
});

test('POST /admin/auth/token-login: empty token → 400', async (t) => {
  const orig = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'right-token';
  t.after(() => {
    if (orig === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = orig;
  });
  const { app } = await setup(t, { idTokenPayload: {} });
  const res = await postTokenLogin(app, '');
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as ErrorBody).error, 'token required');
});

test('POST /admin/auth/token-login: ADMIN_TOKEN unset → 503', async (t) => {
  const orig = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  t.after(() => {
    if (orig !== undefined) process.env.ADMIN_TOKEN = orig;
  });
  const { app } = await setup(t, { idTokenPayload: {} });
  const res = await postTokenLogin(app, 'anything');
  assert.equal(res.statusCode, 503);
  assert.equal((res.json() as ErrorBody).error, 'token login not configured');
});

// Successful logins shouldn't burn the brute-force budget — an
// operator who logs in/out a couple of times is not an attacker
// guessing ADMIN_TOKEN. Verify by interleaving a SUCCESS into a
// stream of WRONGs and confirming the wrong-token counter resets.
test('POST /admin/auth/token-login: success resets the failure counter; only wrong tokens count', async (t) => {
  const orig = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'right-token';
  t.after(() => {
    if (orig === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = orig;
  });
  const { app } = await setup(t, { idTokenPayload: {} });

  // Burn 4 of the 5 failure slots.
  for (let i = 0; i < 4; i++) {
    const r = await postTokenLogin(app, 'wrong-token');
    assert.equal(r.statusCode, 401);
  }
  // A successful login here must clear the tally — without that,
  // the next wrong token would be the 5th miss and the one after
  // would 429.
  assert.equal((await postTokenLogin(app, 'right-token')).statusCode, 302);

  // After the success, the counter is back at 0; we get a full
  // five wrong-token attempts before the limiter kicks in.
  for (let i = 0; i < 5; i++) {
    assert.equal((await postTokenLogin(app, 'wrong-token')).statusCode, 401);
  }
  // The sixth wrong is over the cap.
  const blocked = await postTokenLogin(app, 'wrong-token');
  assert.equal(blocked.statusCode, 429);
  assert.match((blocked.json() as ErrorBody).error, /too many/);
});

test('POST /admin/auth/token-login: 400/503 paths don’t consume the failure budget', async (t) => {
  const orig = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'right-token';
  t.after(() => {
    if (orig === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = orig;
  });
  const { app } = await setup(t, { idTokenPayload: {} });

  // Empty bodies are client bugs, not brute-force probes. Send
  // many; we must still have a full failure budget afterwards.
  for (let i = 0; i < 20; i++) {
    assert.equal((await postTokenLogin(app, '')).statusCode, 400);
  }
  // Five wrong-token attempts now do their full work.
  for (let i = 0; i < 5; i++) {
    assert.equal((await postTokenLogin(app, 'wrong-token')).statusCode, 401);
  }
  assert.equal((await postTokenLogin(app, 'wrong-token')).statusCode, 429);
});

test('POST /admin/auth/token-login: second login is idempotent (one synthetic admin row)', async (t) => {
  const orig = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'right-token';
  t.after(() => {
    if (orig === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = orig;
  });
  const { db, app } = await setup(t, { idTokenPayload: {} });
  const r1 = await postTokenLogin(app, 'right-token');
  const r2 = await postTokenLogin(app, 'right-token');
  assert.equal(r1.statusCode, 302);
  assert.equal(r2.statusCode, 302);
  const count = (
    db
      .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE email = ?')
      .get('admin@token.local') ?? { n: 0 }
  ).n;
  assert.equal(count, 1, 'one synthetic admin row across multiple logins');
});

test('token-login session lets user reach /admin/editor', async (t) => {
  const orig = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'right-token';
  t.after(() => {
    if (orig === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = orig;
  });
  const { app } = await setup(t, { idTokenPayload: {} });
  const login = await postTokenLogin(app, 'right-token');
  const setCookie = ([] as string[]).concat(login.headers['set-cookie'] as string | string[]);
  const sessionLine = setCookie.find((c) => c.startsWith('rkr_session=')) ?? '';
  const sid = sessionLine.split(';')[0]?.split('=')[1] ?? '';

  const editor = await app.inject({
    method: 'GET',
    url: '/admin/editor',
    headers: { cookie: `rkr_session=${sid}` }
  });
  assert.equal(editor.statusCode, 200, `body=${editor.body}`);
  assert.match(editor.body, /<div id="rkroll-admin-root"/);
});
