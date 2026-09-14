import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { buildApp } from '../../src/server.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-auth-nogoogle-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'data', 'content/posts']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function setup(t: TestContext): Promise<Awaited<ReturnType<typeof buildApp>>> {
  const saved = {
    id: process.env.GOOGLE_CLIENT_ID,
    secret: process.env.GOOGLE_CLIENT_SECRET,
    token: process.env.ADMIN_TOKEN
  };
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  process.env.ADMIN_TOKEN = 'test-admin-token';
  t.after(() => {
    if (saved.id === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = saved.id;
    if (saved.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = saved.secret;
    if (saved.token === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = saved.token;
  });

  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: { secureCookies: false }
  });
  t.after(() => app.close());
  return app;
}

test('server starts with no Google client configured', async (t) => {
  const app = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/login' });
  assert.equal(res.statusCode, 200);
});

test('/login offers token sign-in and hides the Google link', async (t) => {
  const app = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/login' });
  assert.match(res.body, /action="\/admin\/auth\/token-login"/);
  assert.doesNotMatch(res.body, /\/admin\/auth\/google\/start/);
});

test('google start and callback 404 when unconfigured', async (t) => {
  const app = await setup(t);
  const start = await app.inject({ method: 'GET', url: '/admin/auth/google/start' });
  assert.equal(start.statusCode, 404);
  const cb = await app.inject({
    method: 'GET',
    url: '/admin/auth/google/callback?code=x&state=y'
  });
  assert.equal(cb.statusCode, 404);
});
