import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { makeClassifyHandler } from '../../src/lib/classify-handler.ts';
import { applyClassification, getCommentById, insertWebComment } from '../../src/lib/comments.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import type { SpamVerdict } from '../../src/lib/spam-classifier.ts';

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
    authorUrl: null,
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
    })
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
    })
  );
  await handler({ commentId: id }, { siteRoot: '/x', db });
  assert.equal(getCommentById(db, id)?.status, 'queued');
});

test('classifier throwing → comment fails safe to queued (job does NOT throw)', async (t) => {
  const { db, id } = setup(t);
  const handler = makeClassifyHandler(async () => {
    throw new Error('ollama unreachable');
  });
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
    })
  );
  await handler({ commentId: id }, { siteRoot: '/x', db });
  assert.equal(getCommentById(db, id)?.status, 'published');
});
