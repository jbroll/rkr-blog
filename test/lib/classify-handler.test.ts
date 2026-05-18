import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { makeClassifyHandler } from '../../src/lib/classify-handler.ts';
import { applyClassification, getCommentById, insertWebComment } from '../../src/lib/comments.ts';
import { writePersistedSiteConfig } from '../../src/lib/config.ts';
import type { Db } from '../../src/lib/db.ts';
import { open } from '../../src/lib/db.ts';
import { enqueue } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import type { SpamVerdict } from '../../src/lib/spam-classifier.ts';

/** Existing tests don't exercise notify — inject a no-op. */
const noEnqueue = (): void => {};

/** Point siteConfig() (process.env) at a tmp root holding the level. */
function withLevel(t: TestContext, lvl: 'off' | 'ham' | 'queued' | 'all'): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-cn-'));
  writePersistedSiteConfig({ commentNotify: lvl }, { SITE_ROOT: root });
  const prev = process.env.SITE_ROOT;
  process.env.SITE_ROOT = root;
  t.after(() => {
    if (prev === undefined) delete process.env.SITE_ROOT;
    else process.env.SITE_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

function notifyCount(db: Db): number {
  return (
    db.prepare<{ c: number }>("SELECT COUNT(*) c FROM jobs WHERE kind = 'notify'").get()?.c ?? 0
  );
}

function setup(t: TestContext) {
  const db = open(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO posts (slug,title,status,created_at,updated_at,published_at,path)
     VALUES ('p','P','published','2026-01-01','2026-01-01','2026-01-01','content/posts/p.md')`
  ).run();
  const postId = db.prepare<{ id: number }>('SELECT id FROM posts').get()?.id as number;
  t.after(() => db.close());
  const id = insertWebComment(db, {
    postId,
    parentId: null,
    authorName: 'A',
    authorEmail: 'a@e.com',
    body: 'hello',
    ip: null
  });
  return { db, id };
}

test('ham verdict publishes the comment', async (t) => {
  const { db, id } = setup(t);
  const handler = makeClassifyHandler(
    async (): Promise<SpamVerdict> => ({
      verdict: 'ham',
      score: 0.01,
      reason: 'ok'
    }),
    noEnqueue
  );
  await handler({ commentId: id }, { siteRoot: '/x', db });
  assert.equal(getCommentById(db, id)?.status, 'published');
  assert.equal(getCommentById(db, id)?.spam_score, 0.01);
});

test('spam verdict queues the comment', async (t) => {
  const { db, id } = setup(t);
  const handler = makeClassifyHandler(
    async (): Promise<SpamVerdict> => ({
      verdict: 'spam',
      score: 0.95,
      reason: 'links'
    }),
    noEnqueue
  );
  await handler({ commentId: id }, { siteRoot: '/x', db });
  assert.equal(getCommentById(db, id)?.status, 'queued');
});

test('classifier throwing → comment fails safe to queued (job does NOT throw)', async (t) => {
  const { db, id } = setup(t);
  const handler = makeClassifyHandler(async () => {
    throw new Error('ollama unreachable');
  }, noEnqueue);
  await handler({ commentId: id }, { siteRoot: '/x', db });
  assert.equal(getCommentById(db, id)?.status, 'queued');
});

test('a comment no longer pending is left untouched', async (t) => {
  const { db, id } = setup(t);
  applyClassification(db, id, { status: 'published', score: 0, reason: 'manual' });
  const handler = makeClassifyHandler(
    async (): Promise<SpamVerdict> => ({
      verdict: 'spam',
      score: 1,
      reason: 'x'
    }),
    noEnqueue
  );
  await handler({ commentId: id }, { siteRoot: '/x', db });
  assert.equal(getCommentById(db, id)?.status, 'published');
});

test('level ham → notify on ham only', async (t) => {
  const { db, id } = setup(t);
  withLevel(t, 'ham');
  await makeClassifyHandler(
    async (): Promise<SpamVerdict> => ({ verdict: 'ham', score: 0, reason: 'k' }),
    enqueue
  )({ commentId: id }, { siteRoot: '/x', db });
  assert.equal(notifyCount(db), 1);
  const { db: db2, id: id2 } = setup(t);
  await makeClassifyHandler(
    async (): Promise<SpamVerdict> => ({ verdict: 'spam', score: 1, reason: 'k' }),
    enqueue
  )({ commentId: id2 }, { siteRoot: '/x', db: db2 });
  assert.equal(notifyCount(db2), 0);
});

test('level queued → notify on spam/error only', async (t) => {
  const { db, id } = setup(t);
  withLevel(t, 'queued');
  await makeClassifyHandler(
    async (): Promise<SpamVerdict> => ({ verdict: 'ham', score: 0, reason: 'k' }),
    enqueue
  )({ commentId: id }, { siteRoot: '/x', db });
  assert.equal(notifyCount(db), 0);
  const { db: db2, id: id2 } = setup(t);
  await makeClassifyHandler(async () => {
    throw new Error('down');
  }, enqueue)({ commentId: id2 }, { siteRoot: '/x', db: db2 });
  assert.equal(notifyCount(db2), 1);
});

test('level all → both; level off → neither', async (t) => {
  const { db, id } = setup(t);
  withLevel(t, 'all');
  await makeClassifyHandler(
    async (): Promise<SpamVerdict> => ({ verdict: 'ham', score: 0, reason: 'k' }),
    enqueue
  )({ commentId: id }, { siteRoot: '/x', db });
  const { db: db2, id: id2 } = setup(t);
  await makeClassifyHandler(
    async (): Promise<SpamVerdict> => ({ verdict: 'spam', score: 1, reason: 'k' }),
    enqueue
  )({ commentId: id2 }, { siteRoot: '/x', db: db2 });
  assert.equal(notifyCount(db) + notifyCount(db2), 2);

  const { db: db3, id: id3 } = setup(t);
  withLevel(t, 'off');
  await makeClassifyHandler(
    async (): Promise<SpamVerdict> => ({ verdict: 'ham', score: 0, reason: 'k' }),
    enqueue
  )({ commentId: id3 }, { siteRoot: '/x', db: db3 });
  assert.equal(notifyCount(db3), 0);
});
