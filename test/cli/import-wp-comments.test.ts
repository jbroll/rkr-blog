import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import importWpCommentsCmd, { importWpComments } from '../../src/cli/import-wp-comments.ts';
import { getPostIdBySlug, listPublishedThread } from '../../src/lib/comments.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import type { WpFetcher } from '../../src/lib/wp-rest.ts';

function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-impc-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  db.prepare(
    `INSERT INTO posts (slug,title,status,created_at,updated_at,published_at,path)
     VALUES ('hello','Hello','published','2026-01-01','2026-01-01','2026-01-01','content/posts/hello.md')`
  ).run();
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root };
}

function wpFetcher(): WpFetcher {
  return async (url) => {
    if (url.includes('/wp/v2/posts')) {
      return new Response(JSON.stringify([{ id: 2149, slug: 'hello' }]), {
        status: 200,
        headers: { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' }
      });
    }
    return new Response(
      JSON.stringify([
        {
          id: 10,
          post: 2149,
          parent: 0,
          author_name: 'Ann',
          author_url: '',
          date: '2026-05-01T10:00:00',
          content: { rendered: '<p>great&nbsp;post</p>' }
        },
        {
          id: 11,
          post: 2149,
          parent: 10,
          author_name: 'Bo',
          author_url: 'http://bo',
          date: '2026-05-02T10:00:00',
          content: { rendered: '<p>reply</p>' }
        },
        {
          id: 12,
          post: 9999,
          parent: 0,
          author_name: 'Orphan',
          author_url: '',
          date: '2026-05-03T10:00:00',
          content: { rendered: '<p>no post</p>' }
        },
        {
          id: 13,
          post: 2149,
          parent: 11,
          author_name: 'Deep',
          author_url: '',
          date: '2026-05-04T10:00:00',
          content: { rendered: '<p>reply to a reply</p>' }
        }
      ]),
      { status: 200, headers: { 'X-WP-Total': '4', 'X-WP-TotalPages': '1' } }
    );
  };
}

test('imports approved comments, maps parent, skips unknown post, is idempotent', async (t) => {
  const { root } = setup(t);
  const r1 = await importWpComments('https://roll-along.example', root, wpFetcher());
  assert.equal(r1.inserted, 3);
  assert.equal(r1.skipped, 1);

  const db = open(path.join(root, 'data', 'site.db'));
  const rows = db
    .prepare<{ wp_comment_id: number; parent_id: number | null; body: string; status: string }>(
      'SELECT wp_comment_id,parent_id,body,status FROM comments ORDER BY wp_comment_id'
    )
    .all();
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.status, 'published');
  assert.ok(rows[0]?.body.includes('great'));
  assert.ok(!rows[0]?.body.includes('<p>'));

  // wp 11 (reply to top-level 10) should have parent_id = local id of wp 10
  const reply = rows.find((x) => x.wp_comment_id === 11);
  assert.equal(
    reply?.parent_id,
    db.prepare<{ id: number }>('SELECT id FROM comments WHERE wp_comment_id=10').get()?.id
  );

  // wp 13 (reply-to-reply: parent wp 11 is itself a reply) must be flattened
  // to top-level (parent_id null), not attached to wp 11's local id
  const deep = rows.find((x) => x.wp_comment_id === 13);
  assert.equal(deep?.parent_id, null, 'depth-2 WP comment must be flattened to top-level');

  // listPublishedThread must reach all 3 inserted comments (no orphans)
  const postId = getPostIdBySlug(db, 'hello');
  assert.ok(postId !== null);
  const thread = listPublishedThread(db, postId);
  const reachable = thread.reduce((n, top) => n + 1 + top.replies.length, 0);
  assert.equal(reachable, 3, 'all 3 imported comments must be reachable in rendered thread');

  db.close();

  const r2 = await importWpComments('https://roll-along.example', root, wpFetcher());
  assert.equal(r2.inserted, 0);
  const db2 = open(path.join(root, 'data', 'site.db'));
  assert.equal(db2.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM comments').get()?.n, 3);
  db2.close();
});

test('author_name empty → Anonymous; author_url empty → null', async (t) => {
  const { root } = setup(t);
  const fetcher: WpFetcher = async (url) => {
    if (url.includes('/wp/v2/posts')) {
      return new Response(JSON.stringify([{ id: 1, slug: 'hello' }]), {
        status: 200,
        headers: { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' }
      });
    }
    return new Response(
      JSON.stringify([
        {
          id: 20,
          post: 1,
          parent: 0,
          author_name: '',
          author_url: '',
          date: '2026-05-01T10:00:00',
          content: { rendered: '<p>hi</p>' }
        }
      ]),
      { status: 200, headers: { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' } }
    );
  };
  await importWpComments('https://roll-along.example', root, fetcher);
  const db = open(path.join(root, 'data', 'site.db'));
  const row = db
    .prepare<{ author_name: string; author_url: string | null }>(
      'SELECT author_name, author_url FROM comments WHERE wp_comment_id=20'
    )
    .get();
  assert.equal(row?.author_name, 'Anonymous');
  assert.equal(row?.author_url, null);
  db.close();
});

test('htmlToText handles &amp; &#39; <br> entities', async (t) => {
  const { root } = setup(t);
  const fetcher: WpFetcher = async (url) => {
    if (url.includes('/wp/v2/posts')) {
      return new Response(JSON.stringify([{ id: 1, slug: 'hello' }]), {
        status: 200,
        headers: { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' }
      });
    }
    return new Response(
      JSON.stringify([
        {
          id: 30,
          post: 1,
          parent: 0,
          author_name: 'X',
          author_url: '',
          date: '2026-05-01T10:00:00',
          content: { rendered: '<p>a &amp; b<br>it&#39;s &lt;great&gt;</p>' }
        }
      ]),
      { status: 200, headers: { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' } }
    );
  };
  await importWpComments('https://roll-along.example', root, fetcher);
  const db = open(path.join(root, 'data', 'site.db'));
  const row = db
    .prepare<{ body: string }>('SELECT body FROM comments WHERE wp_comment_id=30')
    .get();
  assert.ok(row?.body.includes('& b'), `expected & b in: ${row?.body}`);
  assert.ok(row?.body.includes("it's"), `expected it's in: ${row?.body}`);
  assert.ok(row?.body.includes('<great>'), `expected <great> in: ${row?.body}`);
  assert.ok(!row?.body.includes('<p>'), 'should strip tags');
  db.close();
});

test('multi-page paging: fetches all pages of posts and comments', async (t) => {
  const { root } = setup(t);
  let postPage = 0;
  let commentPage = 0;
  const fetcher: WpFetcher = async (url) => {
    if (url.includes('/wp/v2/posts')) {
      postPage++;
      if (postPage === 1) {
        return new Response(JSON.stringify([{ id: 1, slug: 'hello' }]), {
          status: 200,
          headers: { 'X-WP-Total': '2', 'X-WP-TotalPages': '2' }
        });
      }
      return new Response(JSON.stringify([{ id: 2, slug: 'other' }]), {
        status: 200,
        headers: { 'X-WP-Total': '2', 'X-WP-TotalPages': '2' }
      });
    }
    commentPage++;
    if (commentPage === 1) {
      return new Response(
        JSON.stringify([
          {
            id: 40,
            post: 1,
            parent: 0,
            author_name: 'X',
            author_url: '',
            date: '2026-05-01T10:00:00',
            content: { rendered: '<p>page1</p>' }
          }
        ]),
        { status: 200, headers: { 'X-WP-Total': '2', 'X-WP-TotalPages': '2' } }
      );
    }
    return new Response(
      JSON.stringify([
        {
          id: 41,
          post: 1,
          parent: 0,
          author_name: 'Y',
          author_url: '',
          date: '2026-05-02T10:00:00',
          content: { rendered: '<p>page2</p>' }
        }
      ]),
      { status: 200, headers: { 'X-WP-Total': '2', 'X-WP-TotalPages': '2' } }
    );
  };
  const r = await importWpComments('https://roll-along.example', root, fetcher);
  assert.equal(r.inserted, 2);
  assert.equal(postPage, 2);
  assert.equal(commentPage, 2);
});

test('default CLI wrapper: missing baseUrl throws usage error', async () => {
  await assert.rejects(() => importWpCommentsCmd([]), /usage:/i);
});
