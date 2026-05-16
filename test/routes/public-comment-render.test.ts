import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { insertWebComment, setCommentStatus } from '../../src/lib/comments.ts';
import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { buildApp } from '../../src/server.ts';

async function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-cmtr-'));
  fs.mkdirSync(path.join(root, 'content', 'posts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'content', 'posts', 'hello.md'),
    '---\ntitle: Hello\nslug: hello\ndate: 2026-01-01T00:00:00.000Z\nstatus: published\n---\n\nBody.\n'
  );
  const db = open(':memory:');
  migrate(db);
  // Insert post row directly into the in-memory db (runReindex opens its own
  // DB file; we need the row in the same db instance passed to buildApp).
  db.prepare(
    `INSERT INTO posts (slug,title,status,created_at,updated_at,published_at,path)
     VALUES ('hello','Hello','published','2026-01-01','2026-01-01','2026-01-01',
             'content/posts/hello.md')`
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

test('GET /:slug?submitted=1 shows notice; GET /:slug without query does not', async (t) => {
  const { app } = await setup(t);
  const withNotice = await app.inject({ method: 'GET', url: '/hello?submitted=1' });
  assert.equal(withNotice.statusCode, 200);
  assert.ok(
    withNotice.body.includes('rkr-comment-notice'),
    'notice element present when submitted=1'
  );
  assert.ok(withNotice.body.includes('role="status"'), 'role="status" present when submitted=1');
  assert.ok(
    withNotice.body.includes('will appear shortly after review'),
    'notice text present when submitted=1'
  );

  const withoutNotice = await app.inject({ method: 'GET', url: '/hello' });
  assert.equal(withoutNotice.statusCode, 200);
  assert.ok(
    !withoutNotice.body.includes('rkr-comment-notice'),
    'notice element absent when no submitted param'
  );
});

test('published comments render on the post page; pending do not', async (t) => {
  const { app, db } = await setup(t);
  const pid = db.prepare<{ id: number }>("SELECT id FROM posts WHERE slug='hello'").get()
    ?.id as number;
  const a = insertWebComment(db, {
    postId: pid,
    parentId: null,
    authorName: 'Ann',
    authorEmail: 'a@e.com',
    body: 'visible comment',
    ip: null
  });
  setCommentStatus(db, a, 'published');
  insertWebComment(db, {
    postId: pid,
    parentId: null,
    authorName: 'Hidden',
    authorEmail: 'h@e.com',
    body: 'pending comment',
    ip: null
  });
  const res = await app.inject({ method: 'GET', url: '/hello' });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('visible comment'));
  assert.ok(!res.body.includes('pending comment'));
  assert.match(res.body, /action="\/hello\/comments"/);
});
