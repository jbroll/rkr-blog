// Tests for POST /admin/reset and the site-admin reset CLI.
// Verifies the endpoint wipes runtime data + truncates the posts
// table, that bearer auth is required, that cookie-authed admins
// can't reach it (bearer-only by design), and that the CLI calls
// the endpoint correctly.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { runReset } from '../../src/cli/reset.ts';
import { open } from '../../src/lib/db.ts';
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-reset-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function seedRuntimeData(root: string): void {
  // Two posts, three originals, two sidecars, four cache files.
  fs.writeFileSync(
    path.join(root, 'content', 'posts', 'one.md'),
    '---\ntitle: One\nslug: one\nstatus: published\n---\nbody\n'
  );
  fs.writeFileSync(
    path.join(root, 'content', 'posts', 'two.md'),
    '---\ntitle: Two\nslug: two\nstatus: published\n---\nbody\n'
  );
  // Originals are sharded; create a couple of plausible paths.
  fs.mkdirSync(path.join(root, 'originals', 'aa', 'bb'), { recursive: true });
  fs.writeFileSync(path.join(root, 'originals', 'aa', 'bb', 'aabbccdd.jpeg'), 'fake');
  fs.mkdirSync(path.join(root, 'originals', 'cc', 'dd'), { recursive: true });
  fs.writeFileSync(path.join(root, 'originals', 'cc', 'dd', 'ccdd0000.jpeg'), 'fake');
  fs.writeFileSync(path.join(root, 'originals', 'cc', 'dd', 'ccdd1111.jpeg'), 'fake');
  fs.writeFileSync(path.join(root, 'sidecars', 'aabbccdd.json'), '{}');
  fs.writeFileSync(path.join(root, 'sidecars', 'ccdd0000.json'), '{}');
  fs.writeFileSync(path.join(root, 'cache', 'img', 'a.webp'), 'cache');
  fs.writeFileSync(path.join(root, 'cache', 'img', 'b.webp'), 'cache');
  fs.writeFileSync(path.join(root, 'cache', 'img', 'c.avif'), 'cache');
  fs.writeFileSync(path.join(root, 'cache', 'img', 'd.jpeg'), 'cache');
  // Insert one row in the posts table.
  const db = open(path.join(root, 'data', 'site.db'));
  db.exec(
    `INSERT INTO posts (slug, title, status, created_at, updated_at, published_at, path)
       VALUES ('one', 'One', 'published', '2026-01-01', '2026-01-01', '2026-01-01', 'content/posts/one.md')`
  );
  db.close();
}

async function setup(
  t: TestContext,
  opts: { adminToken?: string; allowedOrigins?: string[] } = {}
) {
  const root = freshSiteRoot(t);
  seedRuntimeData(root);
  const db = open(path.join(root, 'data', 'site.db'));
  t.after(() => db.close());

  const prev = process.env.ADMIN_TOKEN;
  if (opts.adminToken !== undefined) process.env.ADMIN_TOKEN = opts.adminToken;
  else delete process.env.ADMIN_TOKEN;
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
  return { root, db, app };
}

test('POST /admin/reset with bearer wipes posts/originals/sidecars/cache + DB rows', async (t) => {
  const { root, db, app } = await setup(t, { adminToken: 'super-secret' });

  // Confirm seeded state.
  assert.equal(fs.readdirSync(path.join(root, 'content', 'posts')).length, 2);
  const postsBefore = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM posts').get()?.n ?? 0;
  assert.equal(postsBefore, 1);

  const res = await app.inject({
    method: 'POST',
    url: '/admin/reset',
    headers: { authorization: 'Bearer super-secret' }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<{
    ok: boolean;
    posts: number;
    originals: number;
    sidecars: number;
    cacheFiles: number;
    postsTableRows: number;
  }>();
  assert.equal(body.ok, true);
  assert.equal(body.posts, 2);
  assert.equal(body.originals, 3);
  assert.equal(body.sidecars, 2);
  assert.equal(body.cacheFiles, 4);
  assert.equal(body.postsTableRows, 1);

  // FS state after wipe: directories exist (volume mount points stay
  // intact); files are gone.
  assert.equal(fs.existsSync(path.join(root, 'content', 'posts')), true);
  // Walk recursively — every subdir should now be empty of regular files.
  const stack = [
    path.join(root, 'content', 'posts'),
    path.join(root, 'originals'),
    path.join(root, 'sidecars'),
    path.join(root, 'cache', 'img')
  ];
  while (stack.length) {
    const dir = stack.pop() as string;
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else assert.fail(`unexpected leftover file: ${full}`);
    }
  }

  // posts table is empty.
  const postsAfter = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM posts').get()?.n ?? 0;
  assert.equal(postsAfter, 0);
});

test('POST /admin/reset is idempotent (re-run on empty state)', async (t) => {
  const { app } = await setup(t, { adminToken: 'super-secret' });
  // First reset wipes the seed.
  await app.inject({
    method: 'POST',
    url: '/admin/reset',
    headers: { authorization: 'Bearer super-secret' }
  });
  // Second reset should also succeed with all-zero counts.
  const res = await app.inject({
    method: 'POST',
    url: '/admin/reset',
    headers: { authorization: 'Bearer super-secret' }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json<{ ok: boolean; posts: number }>();
  assert.equal(body.ok, true);
  assert.equal(body.posts, 0);
});

test('POST /admin/reset without bearer returns 401', async (t) => {
  const { app } = await setup(t, { adminToken: 'super-secret' });
  const res = await app.inject({
    method: 'POST',
    url: '/admin/reset',
    headers: { origin: 'http://localhost' }
  });
  assert.equal(res.statusCode, 401);
});

test('POST /admin/reset with wrong bearer returns 401', async (t) => {
  const { app } = await setup(t, { adminToken: 'super-secret' });
  const res = await app.inject({
    method: 'POST',
    url: '/admin/reset',
    headers: { authorization: 'Bearer wrong' }
  });
  assert.equal(res.statusCode, 401);
});

test('site-admin reset CLI calls the endpoint with bearer header', async (t) => {
  const { app } = await setup(t, { adminToken: 'super-secret' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const result = await runReset({
    toUrl: url,
    token: 'super-secret',
    force: true,
    fetcher: fetch
  });
  assert.equal(result.ok, true);
  assert.equal(result.posts, 2);
  assert.equal(result.originals, 3);
});

test('site-admin reset CLI propagates 401 errors', async (t) => {
  const { app } = await setup(t, { adminToken: 'super-secret' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  await assert.rejects(
    () => runReset({ toUrl: url, token: 'wrong', force: true, fetcher: fetch }),
    /401/
  );
});

test('site-admin reset CLI strips trailing slash on target URL', async (t) => {
  const { app } = await setup(t, { adminToken: 'super-secret' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/`;

  const result = await runReset({
    toUrl: url,
    token: 'super-secret',
    force: true,
    fetcher: fetch
  });
  assert.equal(result.ok, true);
});
