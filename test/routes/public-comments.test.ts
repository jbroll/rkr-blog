import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { listForModeration } from '../../src/lib/comments.ts';
import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { buildApp } from '../../src/server.ts';

async function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-cmt-'));
  const db = open(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO posts (slug,title,status,created_at,updated_at,published_at,path)
     VALUES ('hello','Hello','published','2026-01-01','2026-01-01','2026-01-01','content/posts/hello.md')`
  ).run();
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    events.removeAllListeners('enqueued');
  });
  return { app, db };
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

test('valid submission stores a pending comment + enqueues a classify job + 303', async (t) => {
  const { app, db } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/hello/comments',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ name: 'Ann', email: 'ann@e.com', url: '', body: 'nice', website: '', t: '0' })
  });
  assert.equal(res.statusCode, 303);
  assert.match(res.headers.location as string, /\/hello\?submitted=1#respond/);
  const c = db.prepare<{ status: string }>('SELECT status FROM comments').get();
  assert.equal(c?.status, 'pending');
  const j = db.prepare<{ kind: string; state: string }>('SELECT kind,state FROM jobs').get();
  assert.equal(j?.kind, 'classify');
});

test('honeypot filled → silent reject (no row, still 303)', async (t) => {
  const { app, db } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/hello/comments',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ name: 'Bot', email: 'b@e.com', url: '', body: 'spam', website: 'x', t: '0' })
  });
  assert.equal(res.statusCode, 303);
  assert.equal(db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM comments').get()?.n, 0);
});

test('x-rkr-ajax header → 200 JSON {ok,notice}, still stores + enqueues (no flicker path)', async (t) => {
  const { app, db } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/hello/comments',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-rkr-ajax': '1' },
    payload: form({ name: 'Ann', email: 'ann@e.com', body: 'nice', website: '', t: '0' })
  });
  assert.equal(res.statusCode, 200);
  const j = res.json() as { ok: boolean; notice: string };
  assert.equal(j.ok, true);
  assert.match(j.notice, /received and will appear shortly/);
  assert.equal(res.headers.location, undefined);
  assert.equal(
    db.prepare<{ status: string }>('SELECT status FROM comments').get()?.status,
    'pending'
  );
});

test('honeypot + x-rkr-ajax → identical 200 JSON (bot cannot distinguish)', async (t) => {
  const { app, db } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/hello/comments',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-rkr-ajax': '1' },
    payload: form({ name: 'Bot', email: 'b@e.com', body: 'spam', website: 'x', t: '0' })
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    ok: true,
    notice: 'Thanks — your comment has been received and will appear shortly after review.'
  });
  assert.equal(db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM comments').get()?.n, 0);
});

test('missing required fields → 400', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/hello/comments',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ name: '', email: 'a@e.com', body: '', website: '', t: '0' })
  });
  assert.equal(res.statusCode, 400);
});

test('unknown post slug → 404', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/nope/comments',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ name: 'A', email: 'a@e.com', body: 'hi', website: '', t: '0' })
  });
  assert.equal(res.statusCode, 404);
});

test('field exceeds max length → 400', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/hello/comments',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ name: 'A'.repeat(81), email: 'a@e.com', body: 'hi', website: '', t: '0' })
  });
  assert.equal(res.statusCode, 400);
});

test('invalid email → 400', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/hello/comments',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ name: 'Ann', email: 'notanemail', body: 'hi', website: '', t: '0' })
  });
  assert.equal(res.statusCode, 400);
});

test('non-numeric parent_id → 400', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/hello/comments',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({
      name: 'Ann',
      email: 'ann@e.com',
      body: 'hi',
      website: '',
      t: '0',
      parent_id: 'abc'
    })
  });
  assert.equal(res.statusCode, 400);
});

test('parent_id referencing non-existent comment → 400', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/hello/comments',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({
      name: 'Ann',
      email: 'ann@e.com',
      body: 'hi',
      website: '',
      t: '0',
      parent_id: '999'
    })
  });
  assert.equal(res.statusCode, 400);
});

test('too-fast submission is accepted but queued, not published-eligible', async (t) => {
  const { app, db } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/hello/comments',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({
      name: 'Speedy',
      email: 's@e.com',
      url: '',
      body: 'too fast',
      website: '',
      t: String(Date.now())
    })
  });
  assert.equal(res.statusCode, 303);
  const mod = listForModeration(db);
  assert.equal(mod[0]?.status, 'queued');
});

test('__proto__ key in body does not pollute Object.prototype', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/hello/comments',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: '__proto__[polluted]=yes&name=A&email=a%40e.com&body=hi&website=&t=0'
  });
  assert.ok([303, 400, 404].includes(res.statusCode));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
