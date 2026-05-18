import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';

import { insertWebComment, setCommentStatus } from '../../src/lib/comments.ts';
import { open } from '../../src/lib/db.ts';
import type { Mailer } from '../../src/lib/mailer.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { makeNotifyHandler } from '../../src/lib/notify-handler.ts';

function seed(t: TestContext, status: 'published' | 'queued' | 'pending') {
  const db = open(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO posts (slug,title,status,created_at,updated_at,published_at,path)
     VALUES ('hello','Hi','published','2026-01-01','2026-01-01','2026-01-01','content/posts/hello.md')`
  ).run();
  const postId = db.prepare<{ id: number }>('SELECT id FROM posts').get()?.id as number;
  t.after(() => db.close());
  const commentId = insertWebComment(db, {
    postId,
    parentId: null,
    authorName: 'Ann',
    authorEmail: 'ann@e.com',
    body: 'great post',
    ip: null
  });
  if (status !== 'pending') setCommentStatus(db, commentId, status);
  return { db, commentId };
}

function capturing(): { sent: { subject: string; text: string }[]; mailer: Mailer } {
  const sent: { subject: string; text: string }[] = [];
  return {
    sent,
    mailer: {
      async sendMail(m) {
        sent.push({ subject: m.subject, text: m.text });
        return { sent: true };
      }
    }
  };
}

test('published comment → email with permalink + admin link', async (t) => {
  const { db, commentId } = seed(t, 'published');
  const { sent, mailer } = capturing();
  process.env.PUBLIC_BASE_URL = 'https://ex.test';
  await makeNotifyHandler(mailer)({ commentId }, { siteRoot: '/x', db });
  assert.equal(sent.length, 1);
  const m0 = sent[0];
  assert.ok(m0);
  assert.match(m0.subject, /New comment on "Hi" by Ann/);
  assert.match(m0.text, /https:\/\/ex\.test\/hello#comment-/);
  assert.match(m0.text, /https:\/\/ex\.test\/admin\/comments/);
});

test('queued comment → moderation subject', async (t) => {
  const { db, commentId } = seed(t, 'queued');
  const { sent, mailer } = capturing();
  await makeNotifyHandler(mailer)({ commentId }, { siteRoot: '/x', db });
  const m0 = sent[0];
  assert.ok(m0);
  assert.match(m0.subject, /\[moderation\] Held comment on "Hi" by Ann/);
});

test('missing / non-published-or-queued comment → silent, no send', async (t) => {
  const { db } = seed(t, 'pending');
  const { sent, mailer } = capturing();
  await makeNotifyHandler(mailer)({ commentId: 999999 }, { siteRoot: '/x', db });
  await makeNotifyHandler(mailer)({ commentId: 1 }, { siteRoot: '/x', db });
  assert.equal(sent.length, 0);
});

test('ctx.db missing → throws (programmer error, like classify)', async () => {
  const { mailer } = capturing();
  await assert.rejects(() => makeNotifyHandler(mailer)({ commentId: 1 }, { siteRoot: '/x' }));
});
