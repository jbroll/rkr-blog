import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
import { readVideoSidecar } from '../../src/lib/video-sidecar.ts';
import type { TokenExchange } from '../../src/routes/auth.ts';
import type { DriveTokenExchange } from '../../src/routes/integrations-gdrive.ts';
import { buildApp } from '../../src/server.ts';
import {
  type AccessBody,
  type ErrorBody,
  type ImportResponseBody,
  type StatusBody,
  type StubOpts,
  stubOAuth2Tokens
} from '../helpers/oauth-fixtures.ts';

/**
 * Stub auth.exchange so authRoutes registers without GOOGLE_CLIENT_ID env.
 * No test in this file actually exercises the login flow; we just need
 * the auth wiring (cookie middleware, requireUser preHandler) to attach.
 */
const noopAuthExchange: TokenExchange = {
  authorizationUrl: () => new URL('https://example.com/'),
  exchange: async () => {
    throw new Error('not used in this test file');
  }
};

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-gdrive-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'data', 'content/posts']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  ensureSecretKey(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function stubExchange(opts: StubOpts = {}): DriveTokenExchange {
  return {
    authorizationUrl(state) {
      const u = new URL('https://accounts.google.com/test/authorize');
      u.searchParams.set('state', state);
      return u;
    },
    async exchange() {
      if (opts.exchangeThrows) throw opts.exchangeThrows;
      return stubOAuth2Tokens(
        opts.exchangeReturns ?? {
          accessToken: 'access-token-1',
          refreshToken: 'refresh-token-1',
          expiresInSeconds: 3600,
          scopes: ['https://www.googleapis.com/auth/drive.file']
        }
      );
    },
    async refresh() {
      return stubOAuth2Tokens(
        opts.refreshReturns ?? {
          accessToken: 'access-token-refreshed',
          expiresInSeconds: 3600
        }
      );
    }
  };
}

function stubDriveFetcher(filename: string, mime: string, body: Buffer): typeof fetch {
  return (async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (/\?fields=/.test(u)) {
      return new Response(
        JSON.stringify({ id: 'fake-id', name: filename, mimeType: mime, size: body.length }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(body, {
      headers: { 'content-type': mime, 'content-length': String(body.length) }
    });
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
    gdrive: { exchange }
  });
  t.after(() => app.close());

  // Bootstrap a logged-in user + session.
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

test('GET /admin/integrations/gdrive/connect redirects with offline + prompt=consent', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/connect',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 302);
  const url = new URL(res.headers.location as string);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.ok(url.searchParams.get('state'));
});

test('GET /admin/integrations/gdrive/connect 401s without auth', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/admin/integrations/gdrive/connect' });
  assert.equal(res.statusCode, 401);
});

// ---- /callback --------------------------------------------------------

test('callback exchanges code, stores tokens, redirects to /admin/settings', async (t) => {
  const { db, app, user, sessionCookie, root } = await setup(t);
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));

  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/callback?code=abc&state=st',
    headers: { cookie: `${sessionCookie}; rkr_gdrive_state=${stateCookie}` }
  });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/admin/settings');

  const key = readSecretKey(root);
  const stored = readToken(db, key, user.id, 'gdrive');
  assert.ok(stored);
  assert.equal(stored?.access_token, 'access-token-1');
  assert.equal(stored?.refresh_token, 'refresh-token-1');
  assert.match(stored?.scope ?? '', /drive\.file/);
});

test('callback: state mismatch → 400', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'expected', codeVerifier: 'cv' }));
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/callback?code=abc&state=other',
    headers: { cookie: `${sessionCookie}; rkr_gdrive_state=${stateCookie}` }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /state mismatch/);
});

test('callback: no state cookie → 400', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/callback?code=abc&state=st',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /state cookie/);
});

test('callback: provider error → 400', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/callback?error=access_denied',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /provider error/);
});

test('callback: token exchange throws → 400', async (t) => {
  const { app, sessionCookie } = await setup(t, {
    exchangeThrows: new Error('upstream busted')
  });
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/callback?code=abc&state=st',
    headers: { cookie: `${sessionCookie}; rkr_gdrive_state=${stateCookie}` }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /token exchange failed/);
});

// ---- /picker-config --------------------------------------------------

test('picker-config returns 404 when env vars are unset', async (t) => {
  const { app, sessionCookie } = await setup(t);
  // Make sure env vars are clear for this test (they shouldn't be set
  // in CI; defensive cleanup).
  const prev = {
    GOOGLE_PICKER_API_KEY: process.env.GOOGLE_PICKER_API_KEY,
    GOOGLE_PICKER_APP_ID: process.env.GOOGLE_PICKER_APP_ID,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID
  };
  delete process.env.GOOGLE_PICKER_API_KEY;
  delete process.env.GOOGLE_PICKER_APP_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/integrations/gdrive/picker-config',
      headers: { cookie: sessionCookie }
    });
    assert.equal(res.statusCode, 404);
    assert.match(res.json<ErrorBody>().error, /picker not configured/);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('picker-config returns clientId/developerKey/appId when env is set', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const prev = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_PICKER_API_KEY: process.env.GOOGLE_PICKER_API_KEY,
    GOOGLE_PICKER_APP_ID: process.env.GOOGLE_PICKER_APP_ID
  };
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_PICKER_API_KEY = 'devkey';
  process.env.GOOGLE_PICKER_APP_ID = '123';
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/integrations/gdrive/picker-config',
      headers: { cookie: sessionCookie }
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      clientId: 'cid',
      developerKey: 'devkey',
      appId: '123'
    });
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('picker-config 401s without auth', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/picker-config'
  });
  assert.equal(res.statusCode, 401);
});

// ---- /status, /access-token, /disconnect -----------------------------

async function connectFixture(
  t: TestContext,
  opts: StubOpts = {}
): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  sessionCookie: string;
  user: { id: number; email: string };
  db: ReturnType<typeof open>;
  root: string;
}> {
  const ctx = await setup(t, opts);
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  const cb = await ctx.app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/callback?code=abc&state=st',
    headers: { cookie: `${ctx.sessionCookie}; rkr_gdrive_state=${stateCookie}` }
  });
  assert.equal(cb.statusCode, 302);
  return ctx;
}

test('status reports false before connect, true after', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const before = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/status',
    headers: { cookie: sessionCookie }
  });
  assert.equal(before.statusCode, 200);
  assert.equal(before.json<StatusBody>().connected, false);

  // Now connect via the callback flow.
  const ctx = await connectFixture(t);
  const after = await ctx.app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/status',
    headers: { cookie: ctx.sessionCookie }
  });
  assert.equal(after.json<StatusBody>().connected, true);
});

test('access-token returns the stored token while it is fresh', async (t) => {
  const { app, sessionCookie } = await connectFixture(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/access-token',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<AccessBody>().accessToken, 'access-token-1');
});

test('access-token refreshes when the stored token is past expiry', async (t) => {
  const { app, db, user, sessionCookie, root } = await connectFixture(t);

  // Backdate the stored token so isExpired() returns true.
  const past = new Date(Date.now() - 10_000).toISOString();
  db.prepare('UPDATE oauth_tokens SET expires_at = ? WHERE user_id = ?').run(past, user.id);

  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/access-token',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<AccessBody>().accessToken, 'access-token-refreshed');

  // Refresh-token from the original grant is preserved.
  const key = readSecretKey(root);
  const stored = readToken(db, key, user.id, 'gdrive');
  assert.equal(stored?.refresh_token, 'refresh-token-1');
});

test('access-token returns 404 when not connected', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/access-token',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 404);
  assert.match(res.json<ErrorBody>().error, /not connected/);
});

test('disconnect removes the stored token', async (t) => {
  const { app, db, user, sessionCookie, root } = await connectFixture(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/integrations/gdrive/disconnect',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 200);
  const key = readSecretKey(root);
  assert.equal(readToken(db, key, user.id, 'gdrive'), null);
});

// ---- /admin/import/gdrive -------------------------------------------

async function makeJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 60, height: 40, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

test('POST /admin/import/gdrive fetches via Drive API and ingests', async (t) => {
  // Build a fresh app with a stub driveFetcher attached.
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());

  const jpeg = await makeJpeg();
  const driveFetcher = stubDriveFetcher('cat.jpg', 'image/jpeg', jpeg);

  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gdrive: { exchange: stubExchange(), driveFetcher }
  });
  t.after(() => app.close());

  // Set up a connected user.
  inviteEmail(db, 'a@x.com', 'owner');
  const user = findOrCreateOAuthUser(db, {
    provider: 'google',
    sub: 'g-1',
    email: 'a@x.com'
  });
  const session = createSession(db, { userId: user.id });
  const sessionCookie = `rkr_session=${session.id}`;

  // Connect via callback to populate the token.
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  const cb = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/callback?code=abc&state=st',
    headers: { cookie: `${sessionCookie}; rkr_gdrive_state=${stateCookie}` }
  });
  assert.equal(cb.statusCode, 302);

  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gdrive',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: { fileId: 'fake-id' }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<ImportResponseBody>();
  assert.equal(body.bytes, jpeg.length);
  // Ingest re-encodes raster masters to WebP (see ingest-resize.ts).
  assert.equal(body.ext, 'webp');

  const sidecar = await sidecarRead(root, body.id);
  assert.equal(sidecar?.source.kind, 'gdrive');
  assert.equal(sidecar?.source.originalName, 'cat.jpg');
  assert.equal((sidecar?.source as { fileId?: string }).fileId, 'fake-id');
});

test('POST /admin/import/gdrive 412s when not connected', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gdrive',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: { fileId: 'x' }
  });
  assert.equal(res.statusCode, 412);
  assert.match(res.json<ErrorBody>().error, /not connected/);
});

test('POST /admin/import/gdrive 400s on missing fileId', async (t) => {
  const { app, sessionCookie } = await connectFixture(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gdrive',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: {}
  });
  assert.equal(res.statusCode, 400);
});

test('POST /admin/import/gdrive 415s when Drive returns non-image content-type', async (t) => {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());

  const driveFetcher = stubDriveFetcher('notes.txt', 'text/plain', Buffer.from('hello'));
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gdrive: { exchange: stubExchange(), driveFetcher }
  });
  t.after(() => app.close());

  inviteEmail(db, 'a@x.com', 'owner');
  const user = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
  const session = createSession(db, { userId: user.id });
  const sessionCookie = `rkr_session=${session.id}`;
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/callback?code=abc&state=st',
    headers: { cookie: `${sessionCookie}; rkr_gdrive_state=${stateCookie}` }
  });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gdrive',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: { fileId: 'x' }
  });
  assert.equal(res.statusCode, 415);
  assert.match(res.json<ErrorBody>().error, /content-type/);
});

// ---- GET /admin/integrations/gdrive/fetch (raw bytes for the PWA) ----

async function connectedFetchApp(t: TestContext, driveFetcher: typeof fetch) {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gdrive: { exchange: stubExchange(), driveFetcher }
  });
  t.after(() => app.close());
  inviteEmail(db, 'a@x.com', 'owner');
  const user = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
  const session = createSession(db, { userId: user.id });
  const sessionCookie = `rkr_session=${session.id}`;
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/callback?code=abc&state=st',
    headers: { cookie: `${sessionCookie}; rkr_gdrive_state=${stateCookie}` }
  });
  return { app, sessionCookie };
}

test('GET /admin/integrations/gdrive/fetch streams raw image bytes (no re-encode)', async (t) => {
  const jpeg = await makeJpeg();
  const { app, sessionCookie } = await connectedFetchApp(
    t,
    stubDriveFetcher('cat.jpg', 'image/jpeg', jpeg)
  );
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/fetch?fileId=fake-id',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.headers['content-type'] as string, /^image\/jpeg/);
  // Raw passthrough — bytes are the original JPEG, not the WebP the import re-encodes to.
  assert.equal(res.rawPayload.length, jpeg.length);
});

test('GET /admin/integrations/gdrive/fetch 400s on missing fileId', async (t) => {
  const { app, sessionCookie } = await connectFixture(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/fetch',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 400);
});

test('GET /admin/integrations/gdrive/fetch 412s when not connected', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/fetch?fileId=x',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 412);
});

test('GET /admin/integrations/gdrive/fetch 415s on non-image content-type', async (t) => {
  const { app, sessionCookie } = await connectedFetchApp(
    t,
    stubDriveFetcher('notes.txt', 'text/plain', Buffer.from('hello'))
  );
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/fetch?fileId=x',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 415);
});

// ---- POST /admin/import/gdrive/video ---------------------------------

/** Response body for the cloud video-import routes (image shape + urls). */
interface VideoImportBody extends ImportResponseBody {
  videoUrl: string;
  posterUrl: string;
}

/** Fresh temp dir used as a PATH entry holding fake ffmpeg/ffprobe. */
function freshBinDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-gdrive-vid-bin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Fake ffprobe reporting the given probe, ignoring the input file. */
function writeFakeProbe(
  dir: string,
  opts: { width?: number; height?: number; secs?: number; format?: string } = {}
): void {
  const { width = 640, height = 480, secs = 10, format = 'mov,mp4,m4a,3gp,3g2,mj2' } = opts;
  const json = JSON.stringify({
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width, height, duration: String(secs) }
    ],
    format: { format_name: format, duration: String(secs) }
  });
  fs.writeFileSync(path.join(dir, 'ffprobe'), `#!/bin/sh\ncat <<'EOF'\n${json}\nEOF\n`, {
    mode: 0o755
  });
}

/** Fake ffmpeg: writes fake bytes to its last arg (the output path). */
function writeFakeFfmpeg(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'ffmpeg'),
    ['#!/bin/sh', 'for last do :; done', 'printf \'fake-video\' > "$last"', 'exit 0'].join('\n'),
    { mode: 0o755 }
  );
}

function prependPath(t: TestContext, dir: string): void {
  const prev = process.env.PATH;
  process.env.PATH = prev ? `${dir}:${prev}` : dir;
  t.after(() => {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
  });
}

/** Persist a videoCaps override so resolveVideoCaps picks it up. */
function writeVideoCaps(root: string, caps: { maxBytes?: number; maxDurationMs?: number }): void {
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'site.json'), JSON.stringify({ videoCaps: caps }));
}

/** Connected app + a Drive fetcher serving the given bytes as one file. */
async function connectedVideoApp(
  t: TestContext,
  driveFetcher: typeof fetch,
  caps?: { maxBytes?: number; maxDurationMs?: number }
) {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  if (caps) writeVideoCaps(root, caps);

  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gdrive: { exchange: stubExchange(), driveFetcher }
  });
  t.after(() => app.close());

  inviteEmail(db, 'a@x.com', 'owner');
  const user = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
  const session = createSession(db, { userId: user.id });
  const sessionCookie = `rkr_session=${session.id}`;
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  const cb = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/callback?code=abc&state=st',
    headers: { cookie: `${sessionCookie}; rkr_gdrive_state=${stateCookie}` }
  });
  assert.equal(cb.statusCode, 302);
  return { root, app, sessionCookie };
}

test('POST /admin/import/gdrive/video ingests video/* via ingestVideoStream', async (t) => {
  const binDir = freshBinDir(t);
  writeFakeProbe(binDir, { width: 1280, height: 720, secs: 8 });
  writeFakeFfmpeg(binDir);
  prependPath(t, binDir);

  const bytes = Buffer.from('fake-mp4-drive-bytes');
  const expectedId = crypto.createHash('sha256').update(bytes).digest('hex');
  const { root, app, sessionCookie } = await connectedVideoApp(
    t,
    stubDriveFetcher('clip.mp4', 'video/mp4', bytes)
  );

  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gdrive/video',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: { fileId: 'fake-id' }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<VideoImportBody>();
  assert.match(body.id, /^[0-9a-f]{64}$/);
  assert.equal(body.id, expectedId);
  assert.equal(body.bytes, bytes.length);
  assert.equal(body.ext, 'mp4');
  assert.equal(body.deduplicated, false);
  assert.match(body.videoUrl, new RegExp(`^/video/${expectedId}\\.[0-9a-f]{12}\\.mp4$`));
  assert.match(body.posterUrl, new RegExp(`^/video/poster/${expectedId}\\.[0-9a-f]{12}\\.jpg$`));

  const sidecar = await readVideoSidecar(root, expectedId);
  assert.equal(sidecar?.source.kind, 'gdrive');
  assert.equal(sidecar?.source.originalName, 'clip.mp4');
});

test('POST /admin/import/gdrive/video 415s on non-video content-type', async (t) => {
  const { app, sessionCookie } = await connectedVideoApp(
    t,
    stubDriveFetcher('cat.png', 'image/png', Buffer.from('not-a-video'))
  );
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gdrive/video',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: { fileId: 'fake-id' }
  });
  assert.equal(res.statusCode, 415);
  assert.match(res.json<ErrorBody>().error, /content-type must be video\/\*/);
});

test('POST /admin/import/gdrive/video 413s when the source exceeds the video cap', async (t) => {
  const binDir = freshBinDir(t);
  writeFakeProbe(binDir, { secs: 10 });
  writeFakeFfmpeg(binDir);
  prependPath(t, binDir);

  const { app, sessionCookie } = await connectedVideoApp(
    t,
    stubDriveFetcher('long.mp4', 'video/mp4', Buffer.from('fake-mp4-drive-bytes')),
    { maxDurationMs: 1000 }
  );

  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gdrive/video',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: { fileId: 'fake-id' }
  });
  assert.equal(res.statusCode, 413);
  assert.match(res.json<ErrorBody>().error, /maxDurationMs/);
});

test('POST /admin/import/gdrive/video 413s when the stream exceeds the byte pre-cap', async (t) => {
  const { app, sessionCookie } = await connectedVideoApp(
    t,
    stubDriveFetcher('huge.mp4', 'video/mp4', Buffer.from('way-more-than-one-byte')),
    { maxBytes: 1 }
  );

  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gdrive/video',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: { fileId: 'fake-id' }
  });
  assert.equal(res.statusCode, 413);
  assert.match(res.json<ErrorBody>().error, /exceeded limit/);
});

test('POST /admin/import/gdrive/video 412s when not connected', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gdrive/video',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: { fileId: 'fake-id' }
  });
  assert.equal(res.statusCode, 412);
  assert.match(res.json<ErrorBody>().error, /not connected/);
});

test('POST /admin/import/gdrive/video 400s on missing fileId', async (t) => {
  const { app, sessionCookie } = await connectFixture(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gdrive/video',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: {}
  });
  assert.equal(res.statusCode, 400);
});

// ---- /files --------------------------------------------------------------

async function setupConnectedWithFetcher(t: TestContext, driveFetcher: typeof fetch) {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());

  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gdrive: { exchange: stubExchange(), driveFetcher }
  });
  t.after(() => app.close());

  inviteEmail(db, 'a@x.com', 'owner');
  const user = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
  const session = createSession(db, { userId: user.id });
  const sessionCookie = `rkr_session=${session.id}`;
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/callback?code=abc&state=st',
    headers: { cookie: `${sessionCookie}; rkr_gdrive_state=${stateCookie}` }
  });
  return { app, sessionCookie };
}

function filesFixture() {
  return {
    files: [
      {
        id: 'img1',
        name: 'photo.jpg',
        mimeType: 'image/jpeg',
        thumbnailLink: 'https://th/photo'
      },
      { id: 'vid1', name: 'clip.mp4', mimeType: 'video/mp4' },
      { id: 'fld1', name: 'Photos', mimeType: 'application/vnd.google-apps.folder' }
    ],
    nextPageToken: 'p2'
  };
}

function jsonFetcher(payload: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch;
}

test('GET /admin/integrations/gdrive/files: 404 when not connected', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/files?folderId=root',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 404);
  assert.match(res.json<ErrorBody>().error, /not connected/);
});

test('GET /admin/integrations/gdrive/files: returns image files + folders', async (t) => {
  const { app, sessionCookie } = await setupConnectedWithFetcher(t, jsonFetcher(filesFixture()));
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/files?folderId=root',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    items: Array<{ id: string; thumbnailUrl?: string }>;
    nextPageToken: string | null;
  }>();
  assert.deepEqual(
    body.items.map((i) => i.id),
    ['fld1', 'img1']
  );
  assert.equal(body.items.find((i) => i.id === 'img1')?.thumbnailUrl, 'https://th/photo');
  assert.equal(body.nextPageToken, 'p2');
});

test('GET /admin/integrations/gdrive/files: kind=video filters to videos', async (t) => {
  const seen: string[] = [];
  const fetcher = (async (url: string | URL) => {
    seen.push(typeof url === 'string' ? url : url.toString());
    return new Response(JSON.stringify(filesFixture()), {
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  const { app, sessionCookie } = await setupConnectedWithFetcher(t, fetcher);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/files?folderId=root&kind=video',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 200);
  assert.match(new URL(seen[0] ?? '').searchParams.get('q') ?? '', /video\//);
  assert.deepEqual(
    res.json<{ items: Array<{ id: string }> }>().items.map((i) => i.id),
    ['fld1', 'vid1']
  );
});

test('GET /admin/integrations/gdrive/files: forwards pageToken', async (t) => {
  const seen: string[] = [];
  const fetcher = (async (url: string | URL) => {
    seen.push(typeof url === 'string' ? url : url.toString());
    return new Response(JSON.stringify({ files: [] }), {
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
  const { app, sessionCookie } = await setupConnectedWithFetcher(t, fetcher);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/files?folderId=root&pageToken=p2',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 200);
  assert.match(seen[0] ?? '', /pageToken=p2/);
});

test('GET /admin/integrations/gdrive/files: 400 when Drive call fails', async (t) => {
  const fetcher = (async () => new Response('internal error', { status: 500 })) as typeof fetch;
  const { app, sessionCookie } = await setupConnectedWithFetcher(t, fetcher);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/files?folderId=root',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 400);
});

test('GET /admin/integrations/gdrive/files: admits an editor role', async (t) => {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gdrive: { exchange: stubExchange() }
  });
  t.after(() => app.close());
  inviteEmail(db, 'e@x.com', 'editor');
  const user = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-2', email: 'e@x.com' });
  const session = createSession(db, { userId: user.id });
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gdrive/files?folderId=root',
    headers: { cookie: `rkr_session=${session.id}` }
  });
  // No token row, but requireUser (not owner) passed: 404, not 401/403.
  assert.equal(res.statusCode, 404);
});

// Avoid unused-import warning when Readable type-imports stay around.
test.after(() => {
  void Readable;
});
