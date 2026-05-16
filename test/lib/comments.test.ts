import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import {
  applyClassification,
  getCommentById,
  getPostIdBySlug,
  insertImportedComment,
  insertWebComment,
  listForModeration,
  listPublishedThread,
  setCommentStatus
} from '../../src/lib/comments.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';

function setup(t: TestContext) {
  const db = open(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO posts (slug,title,status,created_at,updated_at,published_at,path)
     VALUES ('p','P','published','2026-01-01','2026-01-01','2026-01-01','content/posts/p.md')`
  ).run();
  const postId = db.prepare<{ id: number }>('SELECT id FROM posts').get()?.id as number;
  t.after(() => db.close());
  return { db, postId };
}

test('insertWebComment stores a pending row and getCommentById round-trips', (t) => {
  const { db, postId } = setup(t);
  const id = insertWebComment(db, {
    postId,
    parentId: null,
    authorName: 'Ann',
    authorEmail: 'ann@example.com',
    authorUrl: null,
    body: 'hi',
    ip: '203.0.113.4'
  });
  const row = getCommentById(db, id);
  assert.equal(row?.status, 'pending');
  assert.equal(row?.source, 'web');
  assert.equal(row?.author_name, 'Ann');
});

test('insertWebComment rejects a reply to a non-top-level comment', (t) => {
  const { db, postId } = setup(t);
  const top = insertWebComment(db, {
    postId,
    parentId: null,
    authorName: 'A',
    authorEmail: 'a@e.com',
    authorUrl: null,
    body: 'top',
    ip: null
  });
  const reply = insertWebComment(db, {
    postId,
    parentId: top,
    authorName: 'B',
    authorEmail: 'b@e.com',
    authorUrl: null,
    body: 'reply',
    ip: null
  });
  assert.throws(
    () =>
      insertWebComment(db, {
        postId,
        parentId: reply,
        authorName: 'C',
        authorEmail: 'c@e.com',
        authorUrl: null,
        body: 'deep',
        ip: null
      }),
    /parent must be a top-level comment/
  );
});

test('listPublishedThread returns top-level published comments with their published replies', (t) => {
  const { db, postId } = setup(t);
  const top = insertWebComment(db, {
    postId,
    parentId: null,
    authorName: 'A',
    authorEmail: 'a@e.com',
    authorUrl: null,
    body: 'top',
    ip: null
  });
  setCommentStatus(db, top, 'published');
  const reply = insertWebComment(db, {
    postId,
    parentId: top,
    authorName: 'B',
    authorEmail: 'b@e.com',
    authorUrl: null,
    body: 'reply',
    ip: null
  });
  setCommentStatus(db, reply, 'published');
  const pending = insertWebComment(db, {
    postId,
    parentId: null,
    authorName: 'C',
    authorEmail: 'c@e.com',
    authorUrl: null,
    body: 'pending',
    ip: null
  });
  void pending;
  const thread = listPublishedThread(db, postId);
  assert.equal(thread.length, 1);
  assert.equal(thread[0]?.body, 'top');
  assert.equal(thread[0]?.replies.length, 1);
  assert.equal(thread[0]?.replies[0]?.body, 'reply');
});

test('insertImportedComment inserts as published and is idempotent', (t) => {
  const { db, postId } = setup(t);
  const id = insertImportedComment(db, {
    postId,
    parentId: null,
    wpCommentId: 42,
    authorName: 'WP User',
    authorUrl: null,
    body: 'imported',
    createdAt: '2025-01-01T00:00:00.000Z'
  });
  assert.ok(id !== null);
  const row = getCommentById(db, id as number);
  assert.equal(row?.status, 'published');
  assert.equal(row?.source, 'wp-import');
  // idempotent re-import returns null
  const dup = insertImportedComment(db, {
    postId,
    parentId: null,
    wpCommentId: 42,
    authorName: 'WP User',
    authorUrl: null,
    body: 'imported',
    createdAt: '2025-01-01T00:00:00.000Z'
  });
  assert.equal(dup, null);
});

test('applyClassification updates status, score, reason, and classified_at', (t) => {
  const { db, postId } = setup(t);
  const id = insertWebComment(db, {
    postId,
    parentId: null,
    authorName: 'X',
    authorEmail: 'x@e.com',
    authorUrl: null,
    body: 'test',
    ip: null
  });
  applyClassification(db, id, { status: 'queued', score: 0.9, reason: 'spam-likely' });
  const row = getCommentById(db, id);
  assert.equal(row?.status, 'queued');
  assert.equal(row?.spam_score, 0.9);
  assert.equal(row?.spam_reason, 'spam-likely');
  assert.ok(row?.classified_at !== null);
});

test('listForModeration returns queued then published rows', (t) => {
  const { db, postId } = setup(t);
  const a = insertWebComment(db, {
    postId,
    parentId: null,
    authorName: 'A',
    authorEmail: 'a@e.com',
    authorUrl: null,
    body: 'a',
    ip: null
  });
  setCommentStatus(db, a, 'published');
  const b = insertWebComment(db, {
    postId,
    parentId: null,
    authorName: 'B',
    authorEmail: 'b@e.com',
    authorUrl: null,
    body: 'b',
    ip: null
  });
  setCommentStatus(db, b, 'queued');
  const rows = listForModeration(db);
  // queued comes first
  assert.equal(rows[0]?.status, 'queued');
  assert.equal(rows[1]?.status, 'published');
});

test('getPostIdBySlug returns the post id or null', (t) => {
  const { db, postId } = setup(t);
  assert.equal(getPostIdBySlug(db, 'p'), postId);
  assert.equal(getPostIdBySlug(db, 'nope'), null);
});

test('insertWebComment rejects parentId for a comment on a different post', (t) => {
  const { db, postId } = setup(t);
  // Insert a second post
  db.prepare(
    `INSERT INTO posts (slug,title,status,created_at,updated_at,published_at,path)
     VALUES ('q','Q','published','2026-01-01','2026-01-01','2026-01-01','content/posts/q.md')`
  ).run();
  const postId2 = db.prepare<{ id: number }>('SELECT id FROM posts WHERE slug = ?').get('q')
    ?.id as number;
  const top = insertWebComment(db, {
    postId,
    parentId: null,
    authorName: 'A',
    authorEmail: 'a@e.com',
    authorUrl: null,
    body: 'top',
    ip: null
  });
  assert.throws(
    () =>
      insertWebComment(db, {
        postId: postId2,
        parentId: top,
        authorName: 'B',
        authorEmail: 'b@e.com',
        authorUrl: null,
        body: 'cross',
        ip: null
      }),
    /parent comment not found on this post/
  );
});
