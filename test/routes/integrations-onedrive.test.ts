import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { readToken } from '../../src/lib/oauth-tokens.ts';
import { ensureSecretKey, readSecretKey } from '../../src/lib/secrets.ts';
import { createSession } from '../../src/lib/sessions.ts';
import { read as sidecarRead } from '../../src/lib/sidecar.ts';
import { findOrCreateOAuthUser, inviteEmail } from '../../src/lib/users.ts';
import type { TokenExchange } from '../../src/routes/auth.ts';
import type { OneDriveTokenExchange } from '../../src/routes/integrations-onedrive.ts';
import { buildApp } from '../../src/server.ts';
import {
  type AccessBody,
  type ErrorBody,
  type ImportResponseBody,
  type StatusBody,
  type StubOpts,
  stubOAuth2Tokens
} from '../helpers/oauth-fixtures.ts';

/** auth.exchange stub so authRoutes registers without needing
 * GOOGLE_CLIENT_ID env. None of these tests exercise login. */
const noopAuthExchange: TokenExchange = {
  authorizationUrl: () => new URL('https://example.com/'),
  exchange: async () => {
    throw new Error('not used in this test file');
  }
};

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-onedrive-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'data', 'content/posts']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  ensureSecretKey(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function stubExchange(opts: StubOpts = {}): OneDriveTokenExchange {
  return {
    authorizationUrl(state) {
      const u = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
      u.searchParams.set('state', state);
      return u;
    },
    async exchange() {
      if (opts.exchangeThrows) throw opts.exchangeThrows;
      return stubOAuth2Tokens(
        opts.exchangeReturns ?? {
          accessToken: 'ms-access-1',
          refreshToken: 'ms-refresh-1',
          expiresInSeconds: 3600,
          scopes: ['Files.Read', 'offline_access']
        }
      );
    },
    async refresh() {
      return stubOAuth2Tokens(
        opts.refreshReturns ?? {
          accessToken: 'ms-access-refreshed',
          expiresInSeconds: 3600
        }
      );
    }
  };
}

/** Stub Microsoft Graph fetcher: distinguishes the metadata GET
 * (path ends with the item id, includes $select) from the /content GET
 * (path ends with /content). Returns matching JSON or bytes. */
function stubGraphFetcher(filename: string, mime: string, body: Buffer): typeof fetch {
  return (async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.endsWith('/content')) {
      return new Response(body, {
        headers: { 'content-type': mime, 'content-length': String(body.length) }
      });
    }
    return new Response(
      JSON.stringify({
        id: 'ms-id',
        name: filename,
        size: body.length,
        file: { mimeType: mime }
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;
}

async function setup(t: TestContext, opts: StubOpts = {}) {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());

  const exchange = stubExchange(opts);

  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    onedrive: { exchange }
  });
  t.after(() => app.close());

  inviteEmail(db, 'a@x.com', 'owner');
  const user = findOrCreateOAuthUser(db, {
    provider: 'google',
    sub: 'g-1',
    email: 'a@x.com'
  });
  const session = createSession(db, { userId: user.id });

  return { root, db, app, user, session, sessionCookie: `rkr_session=${session.id}` };
}

// ---- /connect ---------------------------------------------------------

test('GET /admin/integrations/onedrive/connect redirects with prompt=consent', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/onedrive/connect',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 302);
  const url = new URL(res.headers.location as string);
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.ok(url.searchParams.get('state'));
});

test('GET /admin/integrations/onedrive/connect 401s without auth', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/onedrive/connect'
  });
  assert.equal(res.statusCode, 401);
});

// ---- /callback --------------------------------------------------------

test('callback exchanges code, stores tokens, redirects to /admin/editor', async (t) => {
  const { db, app, user, sessionCookie, root } = await setup(t);
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));

  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/onedrive/callback?code=abc&state=st',
    headers: { cookie: `${sessionCookie}; rkr_onedrive_state=${stateCookie}` }
  });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/admin/editor');

  const key = readSecretKey(root);
  const stored = readToken(db, key, user.id, 'onedrive');
  assert.ok(stored);
  assert.equal(stored?.access_token, 'ms-access-1');
  assert.equal(stored?.refresh_token, 'ms-refresh-1');
  assert.match(stored?.scope ?? '', /Files\.Read/);
});

test('callback: state mismatch → 400', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'expected', codeVerifier: 'cv' }));
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/onedrive/callback?code=abc&state=other',
    headers: { cookie: `${sessionCookie}; rkr_onedrive_state=${stateCookie}` }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /state mismatch/);
});

test('callback: missing state cookie → 400', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/onedrive/callback?code=abc&state=st',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /no state cookie/);
});

test('callback: malformed state cookie → 400', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/onedrive/callback?code=abc&state=st',
    headers: { cookie: `${sessionCookie}; rkr_onedrive_state=not-json` }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /malformed state cookie/);
});

test('callback: missing code or state → 400', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/onedrive/callback',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /missing code or state/);
});

test('callback: provider error includes the description', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/onedrive/callback?error=consent_required&error_description=user%20cancelled',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /consent_required.*user cancelled/);
});

test('callback: token exchange throws → 400', async (t) => {
  const { app, sessionCookie } = await setup(t, {
    exchangeThrows: new Error('upstream busted')
  });
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/onedrive/callback?code=abc&state=st',
    headers: { cookie: `${sessionCookie}; rkr_onedrive_state=${stateCookie}` }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /token exchange failed/);
});

// ---- /picker-config --------------------------------------------------

test('picker-config returns 404 when MICROSOFT_CLIENT_ID is unset', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const prev = process.env.MICROSOFT_CLIENT_ID;
  delete process.env.MICROSOFT_CLIENT_ID;
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/integrations/onedrive/picker-config',
      headers: { cookie: sessionCookie }
    });
    assert.equal(res.statusCode, 404);
  } finally {
    if (prev !== undefined) process.env.MICROSOFT_CLIENT_ID = prev;
  }
});

test('picker-config returns clientId + tenant when env is set', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const prev = {
    MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
    MICROSOFT_TENANT_ID: process.env.MICROSOFT_TENANT_ID
  };
  process.env.MICROSOFT_CLIENT_ID = 'ms-cid';
  process.env.MICROSOFT_TENANT_ID = 'consumers';
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/integrations/onedrive/picker-config',
      headers: { cookie: sessionCookie }
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { clientId: 'ms-cid', tenant: 'consumers' });
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ---- /status, /access-token, /disconnect -----------------------------

async function connectFixture(t: TestContext, opts: StubOpts = {}) {
  const ctx = await setup(t, opts);
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  const cb = await ctx.app.inject({
    method: 'GET',
    url: '/admin/integrations/onedrive/callback?code=abc&state=st',
    headers: { cookie: `${ctx.sessionCookie}; rkr_onedrive_state=${stateCookie}` }
  });
  assert.equal(cb.statusCode, 302);
  return ctx;
}

test('status reports false before connect, true after', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const before = await app.inject({
    method: 'GET',
    url: '/admin/integrations/onedrive/status',
    headers: { cookie: sessionCookie }
  });
  assert.equal(before.json<StatusBody>().connected, false);

  const ctx = await connectFixture(t);
  const after = await ctx.app.inject({
    method: 'GET',
    url: '/admin/integrations/onedrive/status',
    headers: { cookie: ctx.sessionCookie }
  });
  assert.equal(after.json<StatusBody>().connected, true);
});

test('access-token returns the stored token while it is fresh', async (t) => {
  const { app, sessionCookie } = await connectFixture(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/onedrive/access-token',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.json<AccessBody>().accessToken, 'ms-access-1');
});

test('access-token refreshes when stored token has expired', async (t) => {
  const { app, db, user, sessionCookie, root } = await connectFixture(t);
  const past = new Date(Date.now() - 10_000).toISOString();
  db.prepare('UPDATE oauth_tokens SET expires_at = ? WHERE user_id = ?').run(past, user.id);

  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/onedrive/access-token',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.json<AccessBody>().accessToken, 'ms-access-refreshed');

  const key = readSecretKey(root);
  const stored = readToken(db, key, user.id, 'onedrive');
  // Microsoft refresh: scopes are passed to refresh(), refresh_token
  // preserved when the response doesn't include a new one (StubTokens
  // default has refreshToken undefined).
  assert.equal(stored?.refresh_token, 'ms-refresh-1');
});

test('disconnect removes the stored token', async (t) => {
  const { app, db, user, sessionCookie, root } = await connectFixture(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/integrations/onedrive/disconnect',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 200);
  const key = readSecretKey(root);
  assert.equal(readToken(db, key, user.id, 'onedrive'), null);
});

// ---- /admin/import/onedrive ------------------------------------------

async function makeJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 60, height: 40, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

test('POST /admin/import/onedrive fetches via Graph and ingests', async (t) => {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());

  const jpeg = await makeJpeg();
  const graphFetcher = stubGraphFetcher('photo.jpg', 'image/jpeg', jpeg);

  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    onedrive: { exchange: stubExchange(), graphFetcher }
  });
  t.after(() => app.close());

  inviteEmail(db, 'a@x.com', 'owner');
  const user = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
  const session = createSession(db, { userId: user.id });
  const sessionCookie = `rkr_session=${session.id}`;

  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  await app.inject({
    method: 'GET',
    url: '/admin/integrations/onedrive/callback?code=abc&state=st',
    headers: { cookie: `${sessionCookie}; rkr_onedrive_state=${stateCookie}` }
  });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/onedrive',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: { fileId: 'ms-id' }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<ImportResponseBody>();
  assert.equal(body.bytes, jpeg.length);
  assert.equal(body.ext, 'jpg');

  const sidecar = await sidecarRead(root, body.id);
  assert.equal(sidecar?.source.kind, 'onedrive');
  assert.equal(sidecar?.source.originalName, 'photo.jpg');
  assert.equal((sidecar?.source as { fileId?: string }).fileId, 'ms-id');
});

test('POST /admin/import/onedrive 412s when not connected', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/onedrive',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: { fileId: 'x' }
  });
  assert.equal(res.statusCode, 412);
  assert.match(res.json<ErrorBody>().error, /not connected/);
});

test('POST /admin/import/onedrive 400s on missing fileId', async (t) => {
  const { app, sessionCookie } = await connectFixture(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/onedrive',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: {}
  });
  assert.equal(res.statusCode, 400);
});

test('POST /admin/import/onedrive 415s on non-image content-type', async (t) => {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());

  const graphFetcher = stubGraphFetcher('notes.txt', 'text/plain', Buffer.from('hello'));
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    onedrive: { exchange: stubExchange(), graphFetcher }
  });
  t.after(() => app.close());

  inviteEmail(db, 'a@x.com', 'owner');
  const user = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
  const session = createSession(db, { userId: user.id });
  const sessionCookie = `rkr_session=${session.id}`;
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  await app.inject({
    method: 'GET',
    url: '/admin/integrations/onedrive/callback?code=abc&state=st',
    headers: { cookie: `${sessionCookie}; rkr_onedrive_state=${stateCookie}` }
  });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/onedrive',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: { fileId: 'x' }
  });
  assert.equal(res.statusCode, 415);
  assert.match(res.json<ErrorBody>().error, /content-type/);
});

test.after(() => {
  void Readable;
});
