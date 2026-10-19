import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import type { PhotosTokenExchange } from '../../src/routes/integrations-gphotos.ts';
import { buildApp } from '../../src/server.ts';
import {
  type ErrorBody,
  type ImportResponseBody,
  type StatusBody,
  type StubOpts,
  stubOAuth2Tokens
} from '../helpers/oauth-fixtures.ts';

/**
 * Stub auth.exchange so authRoutes registers without GOOGLE_CLIENT_ID env.
 */
const noopAuthExchange: TokenExchange = {
  authorizationUrl: () => new URL('https://example.com/'),
  exchange: async () => {
    throw new Error('not used in this test file');
  }
};

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-gphotos-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'data', 'content/posts']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  ensureSecretKey(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function stubExchange(opts: StubOpts = {}): PhotosTokenExchange {
  return {
    authorizationUrl(state) {
      const u = new URL('https://accounts.google.com/test/authorize');
      u.searchParams.set('state', state);
      u.searchParams.set(
        'scope',
        'https://www.googleapis.com/auth/photospicker.mediaitems.readonly'
      );
      return u;
    },
    async exchange() {
      if (opts.exchangeThrows) throw opts.exchangeThrows;
      return stubOAuth2Tokens(
        opts.exchangeReturns ?? {
          accessToken: 'photos-access-1',
          refreshToken: 'photos-refresh-1',
          expiresInSeconds: 3600,
          scopes: ['https://www.googleapis.com/auth/photospicker.mediaitems.readonly']
        }
      );
    },
    async refresh() {
      return stubOAuth2Tokens(
        opts.refreshReturns ?? {
          accessToken: 'photos-access-refreshed',
          expiresInSeconds: 3600
        }
      );
    }
  };
}

/** Stub Photos Picker API: sessions, poll, media-items list, downloads. */
function stubPickerFetcher(
  opts: { done?: boolean; downloadMime?: string; downloadBody?: Buffer } = {}
): typeof fetch {
  const { done = true, downloadMime = 'image/jpeg', downloadBody = Buffer.from('x') } = opts;
  return (async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    if (u.endsWith('/v1/sessions') && method === 'POST') {
      return new Response(
        JSON.stringify({
          id: 'sess-1',
          pickerUri: 'https://photos.google.com/picker/sess-1',
          pollingConfig: { pollInterval: '1s', timeoutIn: '600s' }
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    if (/\/v1\/mediaItems/.test(u) && u.includes('sessionId=sess-1')) {
      return new Response(
        JSON.stringify({
          mediaItems: [
            {
              id: 'mi-1',
              mediaFile: {
                baseUrl: 'https://lh3.googleusercontent.com/dl1',
                filename: 'beach.jpg',
                mimeType: 'image/jpeg'
              }
            }
          ],
          nextPageToken: null
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    if (/\/v1\/sessions\/sess-1$/.test(u)) {
      if (method === 'DELETE')
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ id: 'sess-1', mediaItemsSet: done }), {
        headers: { 'content-type': 'application/json' }
      });
    }
    if (u.endsWith('=d')) {
      return new Response(downloadBody, {
        headers: { 'content-type': downloadMime, 'content-length': String(downloadBody.length) }
      });
    }
    return new Response('unexpected url', { status: 500 });
  }) as typeof fetch;
}

interface PhotosSetupOpts {
  exchangeOpts?: StubOpts;
  pickerOpts?: { done?: boolean; downloadMime?: string; downloadBody?: Buffer };
}

async function setup(t: TestContext, opts: PhotosSetupOpts = {}) {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());

  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gphotos: {
      exchange: stubExchange(opts.exchangeOpts),
      pickerFetcher: stubPickerFetcher(opts.pickerOpts)
    }
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

function connectCookies(sessionCookie: string): string {
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'st', codeVerifier: 'cv' }));
  return `${sessionCookie}; rkr_gphotos_state=${stateCookie}`;
}

async function connect(
  app: Awaited<ReturnType<typeof buildApp>>,
  sessionCookie: string
): Promise<void> {
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gphotos/callback?code=abc&state=st',
    headers: { cookie: connectCookies(sessionCookie) }
  });
  assert.equal(res.statusCode, 302);
}

// ---- /connect ---------------------------------------------------------

test('GET /admin/integrations/gphotos/connect redirects with offline + prompt=consent + photos scope', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gphotos/connect',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 302);
  const target = new URL(res.headers.location as string);
  assert.equal(target.searchParams.get('access_type'), 'offline');
  assert.equal(target.searchParams.get('prompt'), 'consent');
  assert.match(target.searchParams.get('scope') ?? '', /photospicker\.mediaitems\.readonly/);
});

test('GET /admin/integrations/gphotos/connect 401s without auth', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/admin/integrations/gphotos/connect' });
  assert.equal(res.statusCode, 401);
});

// ---- /callback --------------------------------------------------------

test('callback exchanges code, stores gphotos tokens, redirects to /admin/settings', async (t) => {
  const { db, app, user, sessionCookie, root } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gphotos/callback?code=abc&state=st',
    headers: { cookie: connectCookies(sessionCookie) }
  });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/admin/settings');

  const key = readSecretKey(root);
  const stored = readToken(db, key, user.id, 'gphotos');
  assert.ok(stored);
  assert.equal(stored?.access_token, 'photos-access-1');
  assert.equal(stored?.refresh_token, 'photos-refresh-1');
});

test('callback: token exchange failure → 400', async (t) => {
  const { app, sessionCookie } = await setup(t, {
    exchangeOpts: { exchangeThrows: new Error('denied') }
  });
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gphotos/callback?code=abc&state=st',
    headers: { cookie: connectCookies(sessionCookie) }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /token exchange failed/);
});

// ---- /status + /disconnect ---------------------------------------------

test('GET /admin/integrations/gphotos/status reflects connection', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const statusUrl = '/admin/integrations/gphotos/status';
  const before = await app.inject({
    method: 'GET',
    url: statusUrl,
    headers: { cookie: sessionCookie }
  });
  assert.deepEqual(before.json<StatusBody>(), { connected: false });
  await connect(app, sessionCookie);
  const after = await app.inject({
    method: 'GET',
    url: statusUrl,
    headers: { cookie: sessionCookie }
  });
  assert.deepEqual(after.json<StatusBody>(), { connected: true });
});

test('POST /admin/integrations/gphotos/disconnect removes tokens', async (t) => {
  const { db, app, user, sessionCookie, root } = await setup(t);
  await connect(app, sessionCookie);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/integrations/gphotos/disconnect',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 200);
  const key = readSecretKey(root);
  assert.equal(readToken(db, key, user.id, 'gphotos'), null);
});

// ---- sessions ----------------------------------------------------------

test('POST /admin/integrations/gphotos/sessions creates a picking session', async (t) => {
  const { app, sessionCookie } = await setup(t);
  await connect(app, sessionCookie);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/integrations/gphotos/sessions',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ sessionId: string; pickerUri: string }>();
  assert.equal(body.sessionId, 'sess-1');
  assert.ok(body.pickerUri.endsWith('/autoclose'), body.pickerUri);
});

test('POST /admin/integrations/gphotos/sessions 404s when not connected', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/integrations/gphotos/sessions',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 404);
  assert.match(res.json<ErrorBody>().error, /not connected/);
});

test('GET /admin/integrations/gphotos/sessions/:id reports the done flag', async (t) => {
  const { app, sessionCookie } = await setup(t);
  await connect(app, sessionCookie);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gphotos/sessions/sess-1',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { done: true });
});

test('GET /admin/integrations/gphotos/sessions/:id/media-items maps items without download URLs', async (t) => {
  const { app, sessionCookie } = await setup(t);
  await connect(app, sessionCookie);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gphotos/sessions/sess-1/media-items',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ items: Array<{ name?: string }> }>();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]?.name, 'beach.jpg');
  assert.ok(!('downloadUrl' in (body.items[0] ?? {})));
  assert.ok(!JSON.stringify(body).includes('baseUrl'));
});

// ---- import ------------------------------------------------------------

async function makeJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 60, height: 40, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

test('POST /admin/import/gphotos ingests the picked item', async (t) => {
  const jpeg = await makeJpeg();
  const { app, sessionCookie, root } = await setup(t, {
    pickerOpts: { downloadMime: 'image/jpeg', downloadBody: jpeg }
  });
  await connect(app, sessionCookie);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gphotos',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: { sessionId: 'sess-1', mediaItemId: 'mi-1' }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<ImportResponseBody>();
  assert.equal(body.bytes, jpeg.length);
  assert.equal(body.ext, 'webp');

  const sidecar = await sidecarRead(root, body.id);
  assert.equal(sidecar?.source.kind, 'gphotos');
  assert.equal(sidecar?.source.originalName, 'beach.jpg');
  assert.equal((sidecar?.source as { mediaItemId?: string }).mediaItemId, 'mi-1');
});

test('POST /admin/import/gphotos 415s on non-image content-type', async (t) => {
  const videoFetcher = (async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (/\/v1\/mediaItems/.test(u) && u.includes('sessionId=sess-1')) {
      return new Response(
        JSON.stringify({
          mediaItems: [
            {
              id: 'mv-1',
              mediaFile: {
                baseUrl: 'https://lh3.googleusercontent.com/dlv',
                filename: 'clip.mp4',
                mimeType: 'video/mp4'
              }
            }
          ]
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('unexpected url', { status: 500 });
  }) as typeof fetch;
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gphotos: { exchange: stubExchange(), pickerFetcher: videoFetcher }
  });
  t.after(() => app.close());
  inviteEmail(db, 'a@x.com', 'owner');
  const user = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
  const session = createSession(db, { userId: user.id });
  const sessionCookie = `rkr_session=${session.id}`;
  await connect(app, sessionCookie);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gphotos',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: { sessionId: 'sess-1', mediaItemId: 'mv-1' }
  });
  assert.equal(res.statusCode, 415);
});

test('POST /admin/import/gphotos 404s when the item is gone from the session', async (t) => {
  const { app, sessionCookie } = await setup(t);
  await connect(app, sessionCookie);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gphotos',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: { sessionId: 'sess-1', mediaItemId: 'ghost' }
  });
  assert.equal(res.statusCode, 404);
});

test('POST /admin/import/gphotos 404s when not connected', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gphotos',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: { sessionId: 'sess-1', mediaItemId: 'mi-1' }
  });
  assert.equal(res.statusCode, 404);
  assert.match(res.json<ErrorBody>().error, /not connected/);
});

// ---- video import -------------------------------------------------------

/** Fresh temp dir used as a PATH entry holding fake ffmpeg/ffprobe. */
function freshBinDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-gphotos-vid-bin-'));
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
    ['#!/bin/sh', 'for last do :;', 'done', 'printf \'fake-video\' > "$last"', 'exit 0'].join('\n'),
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

test('POST /admin/import/gphotos/video ingests video picks', async (t) => {
  const binDir = freshBinDir(t);
  writeFakeProbe(binDir, { width: 1280, height: 720, secs: 8 });
  writeFakeFfmpeg(binDir);
  prependPath(t, binDir);

  const bytes = Buffer.from('fake-mp4-photos-bytes');
  const expectedId = crypto.createHash('sha256').update(bytes).digest('hex');
  const videoFetcher = (async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    if (/\/v1\/mediaItems/.test(u) && u.includes('sessionId=sess-1')) {
      return new Response(
        JSON.stringify({
          mediaItems: [
            {
              id: 'mv-1',
              mediaFile: {
                baseUrl: 'https://lh3.googleusercontent.com/dlv',
                filename: 'clip.mp4',
                mimeType: 'video/mp4'
              }
            }
          ]
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.endsWith('=dv')) {
      return new Response(bytes, {
        headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) }
      });
    }
    void method;
    return new Response('unexpected url', { status: 500 });
  }) as typeof fetch;

  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gphotos: { exchange: stubExchange(), pickerFetcher: videoFetcher }
  });
  t.after(() => app.close());

  inviteEmail(db, 'a@x.com', 'owner');
  const owner = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
  const session = createSession(db, { userId: owner.id });
  const sessionCookie = `rkr_session=${session.id}`;
  await connect(app, sessionCookie);

  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gphotos/video',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: { sessionId: 'sess-1', mediaItemId: 'mv-1' }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<{ id: string; videoUrl: string; posterUrl: string }>();
  assert.equal(body.id, expectedId);
  assert.ok(body.videoUrl);
  assert.ok(body.posterUrl);
});

// ---- registration gate ---------------------------------------------------

test('gphotos routes stay unregistered without exchange or env', async (t) => {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const saved = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET
  };
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  t.after(() => {
    if (saved.GOOGLE_CLIENT_ID !== undefined) process.env.GOOGLE_CLIENT_ID = saved.GOOGLE_CLIENT_ID;
    if (saved.GOOGLE_CLIENT_SECRET !== undefined)
      process.env.GOOGLE_CLIENT_SECRET = saved.GOOGLE_CLIENT_SECRET;
  });
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false }
  });
  t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/admin/integrations/gphotos/status' });
  assert.equal(res.statusCode, 404);
});

// ---- callback errors --------------------------------------------------------

test('callback: provider error → 400', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gphotos/callback?error=access_denied',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /provider error/);
});

test('callback: state mismatch → 400', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const stateCookie = encodeURIComponent(JSON.stringify({ state: 'expected', codeVerifier: 'cv' }));
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gphotos/callback?code=abc&state=other',
    headers: { cookie: `${sessionCookie}; rkr_gphotos_state=${stateCookie}` }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /state mismatch/);
});

test('callback: no state cookie → 400', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gphotos/callback?code=abc&state=st',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /state cookie/);
});

// ---- session error paths -----------------------------------------------------

function failingPickerFetcher(): typeof fetch {
  return (async () => new Response('picker down', { status: 500 })) as typeof fetch;
}

test('POST /admin/integrations/gphotos/sessions 400s when Picker create fails', async (t) => {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gphotos: { exchange: stubExchange(), pickerFetcher: failingPickerFetcher() }
  });
  t.after(() => app.close());
  inviteEmail(db, 'a@x.com', 'owner');
  const user = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
  const session = createSession(db, { userId: user.id });
  await connect(app, `rkr_session=${session.id}`);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/integrations/gphotos/sessions',
    headers: { cookie: `rkr_session=${session.id}` }
  });
  assert.equal(res.statusCode, 400);
});

test('GET /admin/integrations/gphotos/sessions/:id 400s when poll fails', async (t) => {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gphotos: { exchange: stubExchange(), pickerFetcher: failingPickerFetcher() }
  });
  t.after(() => app.close());
  inviteEmail(db, 'a@x.com', 'owner');
  const user = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
  const session = createSession(db, { userId: user.id });
  await connect(app, `rkr_session=${session.id}`);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gphotos/sessions/sess-1',
    headers: { cookie: `rkr_session=${session.id}` }
  });
  assert.equal(res.statusCode, 400);
});

test('GET /admin/integrations/gphotos/sessions/:id/media-items 400s when list fails', async (t) => {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gphotos: { exchange: stubExchange(), pickerFetcher: failingPickerFetcher() }
  });
  t.after(() => app.close());
  inviteEmail(db, 'a@x.com', 'owner');
  const user = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
  const session = createSession(db, { userId: user.id });
  await connect(app, `rkr_session=${session.id}`);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gphotos/sessions/sess-1/media-items',
    headers: { cookie: `rkr_session=${session.id}` }
  });
  assert.equal(res.statusCode, 400);
});

// ---- DELETE sessions/:id -----------------------------------------------------

test('DELETE /admin/integrations/gphotos/sessions/:id deletes the session', async (t) => {
  const { app, sessionCookie } = await setup(t);
  await connect(app, sessionCookie);
  const res = await app.inject({
    method: 'DELETE',
    url: '/admin/integrations/gphotos/sessions/sess-1',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { deleted: true });
});

test('DELETE /admin/integrations/gphotos/sessions/:id 404s when not connected', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'DELETE',
    url: '/admin/integrations/gphotos/sessions/sess-1',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 404);
});

test('DELETE /admin/integrations/gphotos/sessions/:id 400s when delete fails', async (t) => {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gphotos: { exchange: stubExchange(), pickerFetcher: failingPickerFetcher() }
  });
  t.after(() => app.close());
  inviteEmail(db, 'a@x.com', 'owner');
  const user = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
  const session = createSession(db, { userId: user.id });
  await connect(app, `rkr_session=${session.id}`);
  const res = await app.inject({
    method: 'DELETE',
    url: '/admin/integrations/gphotos/sessions/sess-1',
    headers: { cookie: `rkr_session=${session.id}` }
  });
  assert.equal(res.statusCode, 400);
});

// ---- import validation + failure paths ---------------------------------------

test('POST /admin/import/gphotos 400s on missing sessionId/mediaItemId', async (t) => {
  const { app, sessionCookie } = await setup(t);
  await connect(app, sessionCookie);
  for (const payload of [{}, { sessionId: 'sess-1' }, { mediaItemId: 'mi-1' }]) {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/import/gphotos',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      payload
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

test('POST /admin/import/gphotos/video 400s on missing sessionId/mediaItemId', async (t) => {
  const { app, sessionCookie } = await setup(t);
  await connect(app, sessionCookie);
  for (const payload of [{}, { sessionId: 'sess-1' }, { mediaItemId: 'mi-1' }]) {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/import/gphotos/video',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      payload
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
});

test('POST /admin/import/gphotos 400s when session re-list fails', async (t) => {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gphotos: { exchange: stubExchange(), pickerFetcher: failingPickerFetcher() }
  });
  t.after(() => app.close());
  inviteEmail(db, 'a@x.com', 'owner');
  const user = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
  const session = createSession(db, { userId: user.id });
  await connect(app, `rkr_session=${session.id}`);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gphotos',
    headers: { cookie: `rkr_session=${session.id}`, 'content-type': 'application/json' },
    payload: { sessionId: 'sess-1', mediaItemId: 'mi-1' }
  });
  assert.equal(res.statusCode, 400);
});

test('POST /admin/import/gphotos 400s when download fails', async (t) => {
  const fetcher = (async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (/\/v1\/mediaItems/.test(u) && u.includes('sessionId=sess-1')) {
      return new Response(
        JSON.stringify({
          mediaItems: [
            {
              id: 'mi-1',
              mediaFile: {
                baseUrl: 'https://lh3.googleusercontent.com/dl1',
                filename: 'beach.jpg',
                mimeType: 'image/jpeg'
              }
            }
          ]
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('gone', { status: 500 });
  }) as typeof fetch;
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gphotos: { exchange: stubExchange(), pickerFetcher: fetcher }
  });
  t.after(() => app.close());
  inviteEmail(db, 'a@x.com', 'owner');
  const user = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
  const session = createSession(db, { userId: user.id });
  await connect(app, `rkr_session=${session.id}`);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gphotos',
    headers: { cookie: `rkr_session=${session.id}`, 'content-type': 'application/json' },
    payload: { sessionId: 'sess-1', mediaItemId: 'mi-1' }
  });
  assert.equal(res.statusCode, 400);
  // The upstream body snippet travels in the message for diagnosis.
  assert.match(res.json<ErrorBody>().error, /photos download: HTTP 500 — gone/);
});

test('POST /admin/import/gphotos/video 415s on non-video content-type', async (t) => {
  const { app, sessionCookie } = await setup(t);
  await connect(app, sessionCookie);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gphotos/video',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    payload: { sessionId: 'sess-1', mediaItemId: 'mi-1' }
  });
  assert.equal(res.statusCode, 415);
});

test('POST /admin/import/gphotos/video maps ingest failure to an error status', async (t) => {
  const fetcher = (async (url: string | URL) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (/\/v1\/mediaItems/.test(u) && u.includes('sessionId=sess-1')) {
      return new Response(
        JSON.stringify({
          mediaItems: [
            {
              id: 'mv-1',
              mediaFile: {
                baseUrl: 'https://lh3.googleusercontent.com/dlv',
                filename: 'clip.mp4',
                mimeType: 'video/mp4'
              }
            }
          ]
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(Buffer.from('not-a-video'), {
      headers: { 'content-type': 'video/mp4' }
    });
  }) as typeof fetch;
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gphotos: { exchange: stubExchange(), pickerFetcher: fetcher }
  });
  t.after(() => app.close());
  inviteEmail(db, 'a@x.com', 'owner');
  const user = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
  const session = createSession(db, { userId: user.id });
  await connect(app, `rkr_session=${session.id}`);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/gphotos/video',
    headers: { cookie: `rkr_session=${session.id}`, 'content-type': 'application/json' },
    payload: { sessionId: 'sess-1', mediaItemId: 'mv-1' }
  });
  // ffprobe rejects the junk bytes → probe error maps to a 4xx/5xx, never 200.
  assert.ok(res.statusCode !== 200, `got ${res.statusCode}: ${res.body}`);
});

// ---- token refresh -----------------------------------------------------------

test('expired gphotos token refreshes on next use', async (t) => {
  const { db, app, user, sessionCookie, root } = await setup(t);
  await connect(app, sessionCookie);
  const key = readSecretKey(root);
  const past = new Date(Date.now() - 60_000).toISOString();
  db.prepare('UPDATE oauth_tokens SET expires_at = ? WHERE user_id = ?').run(past, user.id);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/integrations/gphotos/sessions',
    headers: { cookie: sessionCookie }
  });
  assert.equal(res.statusCode, 200, res.body);
  const stored = readToken(db, key, user.id, 'gphotos');
  assert.equal(stored?.access_token, 'photos-access-refreshed');
});

test('callback: malformed state cookie → 400', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gphotos/callback?code=abc&state=st',
    headers: { cookie: `${sessionCookie}; rkr_gphotos_state=${encodeURIComponent('{bad')}` }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /malformed state cookie/);
});

test('callback: new-flow state mismatch → 400', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gphotos/callback?code=abc&state=other',
    headers: { cookie: `${sessionCookie}; rkr_gphotos_state=expected` }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /state mismatch/);
});

test('callback: unknown flow → 400', async (t) => {
  const { app, sessionCookie } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/integrations/gphotos/callback?code=abc&state=st',
    headers: { cookie: `${sessionCookie}; rkr_gphotos_state=st` }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /expired or unknown/);
});
