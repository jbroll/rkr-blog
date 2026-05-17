// Bearer-token auth path: when ADMIN_TOKEN is set in the env and a request
// arrives with `Authorization: Bearer <token>`, the auth middleware
// attaches a synthetic admin user. CSRF is skipped on the bearer path
// because there's no cookie auto-attach to defend against.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { _resetLoginThrottle } from '../../src/lib/login-throttle.ts';
import { migrate } from '../../src/lib/migrate.ts';
import type { TokenExchange } from '../../src/routes/auth.ts';
import { buildApp } from '../../src/server.ts';

const noopAuthExchange: TokenExchange = {
  authorizationUrl: () => new URL('https://example.com/'),
  exchange: async () => {
    throw new Error('not used');
  }
};

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-bearer-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function setup(
  t: TestContext,
  opts: { adminToken?: string; allowedOrigins?: string[] } = {}
) {
  // Bearer failures now feed the shared process-wide throttle; reset
  // it per test so a wrong-token case doesn't poison the next one.
  _resetLoginThrottle();
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  t.after(() => db.close());

  // Restore env on test exit so suites running in shared-process mode
  // don't leak ADMIN_TOKEN into each other.
  const prev = process.env.ADMIN_TOKEN;
  if (opts.adminToken !== undefined) {
    process.env.ADMIN_TOKEN = opts.adminToken;
  } else {
    delete process.env.ADMIN_TOKEN;
  }
  t.after(() => {
    if (prev === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prev;
  });

  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: {
      exchange: noopAuthExchange,
      secureCookies: false,
      allowedOrigins: opts.allowedOrigins ?? ['http://localhost']
    }
  });
  t.after(() => app.close());
  return { root, app };
}

const POST_PAYLOAD = {
  slug: 'bearer-test',
  title: 'Bearer test',
  status: 'published' as const,
  markdown: 'Hello from bearer.\n'
};

test('bearer: matching token authenticates a POST /admin/posts call', async (t) => {
  const { root, app } = await setup(t, { adminToken: 'super-secret-123' });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: {
      authorization: 'Bearer super-secret-123',
      origin: 'https://attacker.example' // CSRF would normally block this
    },
    payload: POST_PAYLOAD
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(fs.existsSync(path.join(root, 'content', 'posts', 'bearer-test.md')));
});

test('bearer: missing token + missing cookie returns 401', async (t) => {
  const { app } = await setup(t, { adminToken: 'super-secret-123' });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: { origin: 'http://localhost' },
    payload: POST_PAYLOAD
  });
  assert.equal(res.statusCode, 401);
});

test('bearer: wrong token returns 401 (no fallback to cookie path)', async (t) => {
  const { app } = await setup(t, { adminToken: 'super-secret-123' });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: {
      authorization: 'Bearer not-the-right-one',
      origin: 'http://localhost'
    },
    payload: POST_PAYLOAD
  });
  assert.equal(res.statusCode, 401);
});

test('bearer: token of wrong length still returns 401 cleanly', async (t) => {
  // Different length than the expected token — exercises the
  // length-mismatch branch of bearerMatchesEnv (timingSafeEqual would
  // throw on unequal-length buffers, so the predicate has to check
  // length first).
  const { app } = await setup(t, { adminToken: 'super-secret-123' });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: { authorization: 'Bearer x' },
    payload: POST_PAYLOAD
  });
  assert.equal(res.statusCode, 401);
});

test('bearer: header with no token (just "Bearer") returns 401', async (t) => {
  const { app } = await setup(t, { adminToken: 'super-secret-123' });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: { authorization: 'Bearer' },
    payload: POST_PAYLOAD
  });
  assert.equal(res.statusCode, 401);
});

test('bearer: ADMIN_TOKEN unset → bearer header is rejected', async (t) => {
  // Even a request with Authorization: Bearer ... must 401 if the env
  // var isn't configured. This guards against the "we forgot to set
  // ADMIN_TOKEN in prod" failure mode where a placeholder value would
  // silently grant access.
  const { app } = await setup(t /* no adminToken */);

  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: { authorization: 'Bearer anything' },
    payload: POST_PAYLOAD
  });
  assert.equal(res.statusCode, 401);
});

test('csrf: bearer-authed POST is not subject to the Origin allow-list', async (t) => {
  // The CSRF guard 403s cookie-authenticated POSTs from cross-origin
  // requests. Bearer-authed POSTs must skip that check — there's no
  // cookie auto-attach for the browser to abuse.
  const { app } = await setup(t, {
    adminToken: 'super-secret-123',
    allowedOrigins: ['http://localhost']
  });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: {
      authorization: 'Bearer super-secret-123',
      origin: 'https://attacker.example'
    },
    payload: { ...POST_PAYLOAD, slug: 'cross-origin-bearer' }
  });
  assert.equal(res.statusCode, 200, res.body);
});

test('bearer: repeated wrong tokens against a mutating route eventually 429 (not unlimited 401s)', async (t) => {
  // Before this fix the bearer path was CSRF-exempt AND unthrottled,
  // so ADMIN_TOKEN was brute-forceable with unlimited 401s. Now the
  // shared per-IP tally flips to 429 once the ceiling is hit.
  const { app } = await setup(t, { adminToken: 'super-secret-123' });

  let saw429 = false;
  for (let i = 0; i < 40; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/reindex',
      headers: { authorization: 'Bearer wrong-guess' }
    });
    if (res.statusCode === 429) {
      saw429 = true;
      assert.match((res.json() as { error: string }).error, /too many/);
      break;
    }
    assert.equal(res.statusCode, 401, `attempt ${i} expected 401, got ${res.statusCode}`);
  }
  assert.ok(saw429, 'expected a 429 within 40 wrong-token attempts');
});

test('bearer: a valid token still works and is not throttled after prior failures', async (t) => {
  // clearFailures on a clean success means an operator whose script
  // had a few stale-token retries isn't locked out once it picks up
  // the right token.
  const { app } = await setup(t, { adminToken: 'super-secret-123' });

  // Three wrong attempts (below the ceiling), then the right token.
  for (let i = 0; i < 3; i++) {
    const bad = await app.inject({
      method: 'POST',
      url: '/admin/reindex',
      headers: { authorization: 'Bearer nope' }
    });
    assert.equal(bad.statusCode, 401);
  }
  // /admin/reindex redirects (303) on success — the point is it's
  // authorized, not 401/429.
  const ok = await app.inject({
    method: 'POST',
    url: '/admin/reindex',
    headers: { authorization: 'Bearer super-secret-123' }
  });
  assert.equal(ok.statusCode, 303, ok.body);

  // The success cleared the tally — a full run of wrong attempts is
  // available again rather than the next miss tripping the limiter.
  const stillOk = await app.inject({
    method: 'POST',
    url: '/admin/reindex',
    headers: { authorization: 'Bearer super-secret-123' }
  });
  assert.equal(stillOk.statusCode, 303, stillOk.body);
});

test('csrf: cookie-style POST with mismatched Origin still 403s (regression guard)', async (t) => {
  // Without the bearer header, the CSRF guard must remain in force —
  // the new "skip when Authorization: header is present" branch must
  // not weaken the cookie path.
  const { app } = await setup(t, {
    adminToken: 'super-secret-123',
    allowedOrigins: ['http://localhost']
  });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: { origin: 'https://attacker.example' },
    payload: POST_PAYLOAD
  });
  assert.equal(res.statusCode, 403);
});
