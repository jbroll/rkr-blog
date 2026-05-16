import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { getCommentById, insertWebComment } from '../../src/lib/comments.ts';
import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { buildApp } from '../../src/server.ts';

async function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-admc-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const dbPath = path.join(root, 'data', 'site.db');
  const db = open(dbPath);
  migrate(db);
  db.prepare(
    `INSERT INTO posts (slug,title,status,created_at,updated_at,published_at,path)
     VALUES ('p','P','published','2026-01-01','2026-01-01','2026-01-01','content/posts/p.md')`
  ).run();
  const pid = db.prepare<{ id: number }>('SELECT id FROM posts').get()?.id as number;
  const id = insertWebComment(db, {
    postId: pid,
    parentId: null,
    authorName: 'Sue',
    authorEmail: 's@e.com',
    body: 'queued one',
    ip: null
  });
  db.prepare("UPDATE comments SET status='queued' WHERE id=?").run(id);
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    events.removeAllListeners('enqueued');
  });
  return { app, db, id };
}

test('GET /admin/comments lists queued comments', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/admin/comments' });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('queued one'));
  // follows site theming: links the theme stylesheets, no bespoke inline CSS
  assert.match(res.body, /<link rel="stylesheet" href="\/static\/base\.css/);
  assert.match(res.body, /\/static\/themes\/default\.css/);
  assert.ok(!res.body.includes('<style>'), 'no hardcoded inline stylesheet');
});

test('POST /admin/comments/:id/approve → published + 303', async (t) => {
  const { app, db, id } = await setup(t);
  const res = await app.inject({ method: 'POST', url: `/admin/comments/${id}/approve` });
  assert.equal(res.statusCode, 303);
  assert.equal(getCommentById(db, id)?.status, 'published');
});

test('POST /admin/comments/:id/reject → rejected', async (t) => {
  const { app, db, id } = await setup(t);
  await app.inject({ method: 'POST', url: `/admin/comments/${id}/reject` });
  assert.equal(getCommentById(db, id)?.status, 'rejected');
});

test('POST /admin/comments/:id/delete → row gone', async (t) => {
  const { app, db, id } = await setup(t);
  await app.inject({ method: 'POST', url: `/admin/comments/${id}/delete` });
  assert.equal(getCommentById(db, id), undefined);
});

test('unknown action → 400', async (t) => {
  const { app, id } = await setup(t);
  const res = await app.inject({ method: 'POST', url: `/admin/comments/${id}/bogus` });
  assert.equal(res.statusCode, 400);
});

test('GET /admin/comments with no rows → empty page', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-admc-empty-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const dbPath = path.join(root, 'data', 'site.db');
  const db = open(dbPath);
  migrate(db);
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    events.removeAllListeners('enqueued');
  });
  const res = await app.inject({ method: 'GET', url: '/admin/comments' });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('No comments'));
});

test('POST /admin/comments/:id/action with non-numeric id → 400', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'POST', url: '/admin/comments/abc/approve' });
  assert.equal(res.statusCode, 400);
});

test('POST /admin/comments/:id/approve with missing comment → 404', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'POST', url: '/admin/comments/99999/approve' });
  assert.equal(res.statusCode, 404);
});

test('GET /admin/comments shows published row with Delete action and spam info', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-admc-pub-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const dbPath = path.join(root, 'data', 'site.db');
  const db = open(dbPath);
  migrate(db);
  db.prepare(
    `INSERT INTO posts (slug,title,status,created_at,updated_at,published_at,path)
     VALUES ('q','Q','published','2026-01-01','2026-01-01','2026-01-01','content/posts/q.md')`
  ).run();
  const pid = db.prepare<{ id: number }>('SELECT id FROM posts').get()?.id as number;
  const id = insertWebComment(db, {
    postId: pid,
    parentId: null,
    authorName: 'Bob',
    authorEmail: 'b@e.com',
    body: 'published one',
    ip: null
  });
  db.prepare(
    "UPDATE comments SET status='published', spam_score=0.9, spam_reason='looks spammy' WHERE id=?"
  ).run(id);
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    events.removeAllListeners('enqueued');
  });
  const res = await app.inject({ method: 'GET', url: '/admin/comments' });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('published one'));
  assert.ok(res.body.includes('Delete'));
  assert.ok(res.body.includes('90%'));
  assert.ok(res.body.includes('looks spammy'));
});
