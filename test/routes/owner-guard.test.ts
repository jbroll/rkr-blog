import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { ensureSecretKey } from '../../src/lib/secrets.ts';
import { createSession } from '../../src/lib/sessions.ts';
import { findOrCreateOAuthUser, inviteEmail, type Role } from '../../src/lib/users.ts';
import type { TokenExchange } from '../../src/routes/auth.ts';
import type { DriveTokenExchange } from '../../src/routes/integrations-gdrive.ts';
import type { OneDriveTokenExchange } from '../../src/routes/integrations-onedrive.ts';
import { buildApp } from '../../src/server.ts';
import { stubOAuth2Tokens } from '../helpers/oauth-fixtures.ts';

const noopAuthExchange: TokenExchange = {
  authorizationUrl: () => new URL('https://example.com/'),
  exchange: async () => {
    throw new Error('not used in this test file');
  }
};

// Injecting an exchange is what makes buildApp register the provider
// routes at all; without it they 404 and the guard is never reached.
const providerTokens = () => stubOAuth2Tokens({ accessToken: 'a', expiresInSeconds: 3600 });
const stubDriveExchange: DriveTokenExchange = {
  authorizationUrl: (state) => new URL(`https://example.com/drive?state=${state}`),
  exchange: async () => providerTokens(),
  refresh: async () => providerTokens()
};
const stubOnedriveExchange: OneDriveTokenExchange = {
  authorizationUrl: (state) => new URL(`https://example.com/onedrive?state=${state}`),
  exchange: async () => providerTokens(),
  refresh: async () => providerTokens()
};

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-owner-guard-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  ensureSecretKey(root);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Builds a fully-gated app (cookie auth + requireUser/requireOwner wiring)
// and a session cookie for a freshly-seeded user of the given role.
async function setup(t: TestContext, args: { role: Role }) {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gdrive: { exchange: stubDriveExchange },
    onedrive: { exchange: stubOnedriveExchange }
  });
  t.after(() => app.close());

  inviteEmail(db, 'a@x.com', args.role);
  const user = findOrCreateOAuthUser(db, { provider: 'google', sub: 'g-1', email: 'a@x.com' });
  const session = createSession(db, { userId: user.id });

  return { root, app, sessionCookie: `rkr_session=${session.id}` };
}

// /admin/export additionally enforces its own bearer-only check (the
// synthetic id=0 user), independent of role — a cookie-authed owner
// still can't reach it. Admitting an owner across every OWNER_ONLY
// route therefore has to authenticate the same way production's owner
// tooling does: the ADMIN_TOKEN bearer path.
async function setupBearerOwner(t: TestContext) {
  const root = freshSiteRoot(t);
  const token = 'test-owner-guard-token';
  const prev = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = token;
  t.after(() => {
    if (prev === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prev;
  });
  const db = open(path.join(root, 'data', 'site.db'));
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { exchange: noopAuthExchange, secureCookies: false },
    gdrive: { exchange: stubDriveExchange },
    onedrive: { exchange: stubOnedriveExchange }
  });
  t.after(() => app.close());

  return { root, app, bearerHeader: `Bearer ${token}` };
}

// Every route carrying ownerGuard. requireOwner is a preHandler, so a
// 403 lands before the handler runs and no route needs a fixture.
const OWNER_ONLY = [
  { method: 'GET' as const, url: '/admin/export' },
  { method: 'POST' as const, url: '/admin/import' },
  { method: 'POST' as const, url: '/admin/reset' },
  { method: 'GET' as const, url: '/admin/settings' },
  { method: 'POST' as const, url: '/admin/settings' },
  { method: 'POST' as const, url: '/admin/settings/site' },
  { method: 'POST' as const, url: '/admin/settings/banner' },
  { method: 'POST' as const, url: '/admin/settings/gdrive/disconnect' },
  { method: 'POST' as const, url: '/admin/settings/onedrive/disconnect' },
  { method: 'GET' as const, url: '/admin/integrations/gdrive/connect' },
  { method: 'GET' as const, url: '/admin/integrations/gdrive/callback' },
  { method: 'GET' as const, url: '/admin/integrations/gdrive/access-token' },
  { method: 'POST' as const, url: '/admin/integrations/gdrive/disconnect' },
  { method: 'GET' as const, url: '/admin/integrations/onedrive/connect' },
  { method: 'GET' as const, url: '/admin/integrations/onedrive/callback' },
  { method: 'GET' as const, url: '/admin/integrations/onedrive/access-token' },
  { method: 'GET' as const, url: '/admin/integrations/onedrive/picker-token' },
  { method: 'POST' as const, url: '/admin/integrations/onedrive/disconnect' }
];

const EDITOR_OK = [
  { method: 'GET' as const, url: '/admin/api/tags' },
  { method: 'GET' as const, url: '/admin/editor' }
];

test('owner-only routes reject an editor with 403', async (t) => {
  const { app, sessionCookie } = await setup(t, { role: 'editor' });
  for (const route of OWNER_ONLY) {
    const res = await app.inject({
      method: route.method,
      url: route.url,
      headers: { cookie: sessionCookie }
    });
    assert.equal(res.statusCode, 403, `${route.method} ${route.url}: ${res.body}`);
    assert.match(res.body, /owner role required/);
  }
});

test('owner-only routes admit an owner', async (t) => {
  const { app, bearerHeader } = await setupBearerOwner(t);
  for (const route of OWNER_ONLY) {
    const res = await app.inject({
      method: route.method,
      url: route.url,
      headers: { authorization: bearerHeader }
    });
    assert.notEqual(res.statusCode, 403, `${route.method} ${route.url}: ${res.body}`);
  }
});

test('editor-safe routes still admit an editor', async (t) => {
  const { app, sessionCookie } = await setup(t, { role: 'editor' });
  for (const route of EDITOR_OK) {
    const res = await app.inject({
      method: route.method,
      url: route.url,
      headers: { cookie: sessionCookie }
    });
    assert.notEqual(res.statusCode, 403, `${route.method} ${route.url}: ${res.body}`);
  }
});
