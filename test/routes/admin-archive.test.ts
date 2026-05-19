import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { exportArchive } from '../../src/lib/archive.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import type { TokenExchange } from '../../src/routes/auth.ts';
import { buildApp } from '../../src/server.ts';
import { buildMultipart } from '../helpers/multipart.ts';

const noopAuthExchange: TokenExchange = {
  authorizationUrl: () => new URL('https://example.com/'),
  exchange: async () => {
    throw new Error('not used');
  }
};

const TOKEN = 'test-archive-token';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-arc-route-'));
  for (const sub of ['content/posts', 'data', 'sidecars', 'originals', 'config', 'cache/img']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function setup(t: TestContext) {
  const root = freshSiteRoot(t);
  const prev = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = TOKEN;
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
    auth: { exchange: noopAuthExchange, secureCookies: false, allowedOrigins: ['http://localhost'] }
  });
  t.after(() => app.close());
  return { root, app };
}

// ---- GET /admin/export ----------------------------------------------------

test('GET /admin/export returns sqlite attachment with bearer token', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/export',
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.headers['content-disposition'] as string, /attachment.*\.sqlite/);
  assert.equal(res.headers['content-type'], 'application/vnd.sqlite3');
  // SQLite magic bytes: 53 51 4c 69 74 65 20 66 6f 72 6d 61 74 20 33 00
  assert.equal(res.rawPayload.subarray(0, 6).toString('utf8'), 'SQLite');
});

test('GET /admin/export returns 401 without any auth', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/admin/export' });
  assert.equal(res.statusCode, 401);
});

// ---- POST /admin/import ---------------------------------------------------

test('POST /admin/import restores files from valid archive', async (t) => {
  const { root, app } = await setup(t);

  // Plant a post and build an archive from a temp source site.
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-arc-src-'));
  t.after(() => fs.rmSync(src, { recursive: true, force: true }));
  for (const sub of ['content/posts', 'data', 'sidecars', 'originals', 'config']) {
    fs.mkdirSync(path.join(src, sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(src, 'content', 'posts', '2026-01-01-hi.md'),
    '---\nslug: hi\ntitle: Hi\nstatus: published\ndate: 2026-01-01T00:00:00Z\n---\n\nbody\n'
  );

  const arcPath = path.join(os.tmpdir(), `arc-route-${Date.now()}.sqlite`);
  t.after(() => fs.rmSync(arcPath, { force: true }));
  exportArchive(src, arcPath);

  const { payload, headers } = buildMultipart({
    filename: 'backup.sqlite',
    contentType: 'application/vnd.sqlite3',
    bytes: fs.readFileSync(arcPath)
  });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/import',
    payload,
    headers: { ...headers, authorization: `Bearer ${TOKEN}` }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<{ filesWritten: number }>();
  assert.ok(body.filesWritten >= 1, 'at least one file written');

  assert.ok(
    fs.existsSync(path.join(root, 'content', 'posts', '2026-01-01-hi.md')),
    'post markdown restored'
  );
});

test('POST /admin/import returns 400 for bad archive', async (t) => {
  const { app } = await setup(t);

  const { payload, headers } = buildMultipart({
    filename: 'bad.sqlite',
    contentType: 'application/vnd.sqlite3',
    bytes: Buffer.from('not a sqlite file')
  });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/import',
    payload,
    headers: { ...headers, authorization: `Bearer ${TOKEN}` }
  });
  assert.equal(res.statusCode, 400, res.body);
});

test('POST /admin/import returns 4xx without any auth', async (t) => {
  const { app } = await setup(t);
  const { payload, headers } = buildMultipart({
    filename: 'x.sqlite',
    contentType: 'application/vnd.sqlite3',
    bytes: Buffer.from('x')
  });
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import',
    payload,
    headers
  });
  assert.ok(
    res.statusCode === 401 || res.statusCode === 403,
    `expected 401/403, got ${res.statusCode}`
  );
});

test('POST /admin/import?mode=replace wipes and restores', async (t) => {
  const { root, app } = await setup(t);

  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-arc-src2-'));
  t.after(() => fs.rmSync(src, { recursive: true, force: true }));
  for (const sub of ['content/posts', 'data', 'sidecars', 'originals', 'config']) {
    fs.mkdirSync(path.join(src, sub), { recursive: true });
  }
  fs.writeFileSync(
    path.join(src, 'content', 'posts', '2026-02-01-new.md'),
    '---\nslug: new\ntitle: New\nstatus: published\ndate: 2026-02-01T00:00:00Z\n---\n\nbody\n'
  );

  // exportArchive includes users; replace mode requires at least one owner.
  const srcDb = open(path.join(src, 'data', 'site.db'));
  migrate(srcDb);
  srcDb
    .prepare('INSERT INTO users (email, display_name, role, created_at) VALUES (?,?,?,?)')
    .run('owner@example.com', 'Owner', 'owner', '2026-01-01T00:00:00Z');
  srcDb.close();

  const arcPath = path.join(os.tmpdir(), `arc-replace-${Date.now()}.sqlite`);
  t.after(() => fs.rmSync(arcPath, { force: true }));
  exportArchive(src, arcPath);

  const { payload, headers } = buildMultipart({
    filename: 'backup.sqlite',
    contentType: 'application/vnd.sqlite3',
    bytes: fs.readFileSync(arcPath)
  });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/import?mode=replace',
    payload,
    headers: { ...headers, authorization: `Bearer ${TOKEN}` }
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(fs.existsSync(path.join(root, 'content', 'posts', '2026-02-01-new.md')));
});

test('POST /admin/import returns 400 when no file part', async (t) => {
  const { app } = await setup(t);
  const boundary = '----rkrtest';
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\nhi\r\n--${boundary}--\r\n`;
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import',
    payload: body,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      authorization: `Bearer ${TOKEN}`
    }
  });
  assert.equal(res.statusCode, 400);
});
