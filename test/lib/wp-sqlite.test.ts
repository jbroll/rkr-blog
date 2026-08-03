// sqliteSource: read posts, pages, comments and site info out of a
// converted WordPress dump. Each test builds a minimal schema in a temp
// database rather than depending on the real backup.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { sqliteSource } from '../../src/lib/wp-sqlite.ts';

const SCHEMA = `
CREATE TABLE wp_posts (
  ID INTEGER PRIMARY KEY, post_author INTEGER, post_date TEXT, post_content TEXT,
  post_title TEXT, post_excerpt TEXT, post_status TEXT, post_name TEXT,
  post_modified TEXT, post_parent INTEGER, guid TEXT, post_type TEXT
);
CREATE TABLE wp_postmeta (meta_id INTEGER PRIMARY KEY, post_id INTEGER, meta_key TEXT, meta_value TEXT);
CREATE TABLE wp_terms (term_id INTEGER PRIMARY KEY, name TEXT, slug TEXT);
CREATE TABLE wp_term_taxonomy (term_taxonomy_id INTEGER PRIMARY KEY, term_id INTEGER, taxonomy TEXT);
CREATE TABLE wp_term_relationships (object_id INTEGER, term_taxonomy_id INTEGER);
CREATE TABLE wp_options (option_id INTEGER PRIMARY KEY, option_name TEXT, option_value TEXT);
CREATE TABLE wp_comments (
  comment_ID INTEGER PRIMARY KEY, comment_post_ID INTEGER, comment_author TEXT,
  comment_author_url TEXT, comment_date TEXT, comment_content TEXT,
  comment_approved TEXT, comment_type TEXT DEFAULT '', comment_parent INTEGER
);
`;

function backup(t: TestContext): { dbPath: string; uploadsRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-wp-sqlite-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'wp.db');
  const db = open(dbPath);
  db.exec(SCHEMA);

  const insertPost = db.prepare(
    'INSERT INTO wp_posts (ID, post_date, post_content, post_title, post_excerpt, post_status, post_name, post_modified, post_type) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  insertPost.run(
    10,
    '2026-05-18 21:27:39',
    '<p>Body</p><figure><img src="https://wp.example/wp-content/uploads/2026/05/p-768x1024.jpeg" class="wp-image-77"/></figure>',
    'One final day',
    'Excerpt here',
    'publish',
    'one-final-day',
    '2026-05-19 08:00:00',
    'post'
  );
  insertPost.run(
    11,
    '2026-05-19 14:49:35',
    '<p>Draft body</p>',
    'A few days in Stirling, Scotland',
    '',
    'draft',
    '',
    '2026-05-19 14:49:35',
    'post'
  );
  insertPost.run(
    12,
    '2020-01-01 00:00:00',
    '<p>About us</p>',
    'About',
    '',
    'publish',
    'about',
    '2020-01-01 00:00:00',
    'page'
  );
  insertPost.run(
    77,
    '2026-05-08 00:00:00',
    '',
    'photo',
    '',
    'inherit',
    'photo',
    '2026-05-08 00:00:00',
    'attachment'
  );

  db.prepare('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?,?,?)').run(
    10,
    '_thumbnail_id',
    '77'
  );
  db.prepare('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?,?,?)').run(
    77,
    '_wp_attached_file',
    '2026/05/p.jpeg'
  );

  db.prepare('INSERT INTO wp_terms VALUES (?,?,?)').run(1, 'Scotland', 'scotland');
  db.prepare('INSERT INTO wp_terms VALUES (?,?,?)').run(2, 'Travel', 'travel');
  db.prepare('INSERT INTO wp_term_taxonomy VALUES (?,?,?)').run(1, 1, 'post_tag');
  db.prepare('INSERT INTO wp_term_taxonomy VALUES (?,?,?)').run(2, 2, 'category');
  db.prepare('INSERT INTO wp_term_relationships VALUES (?,?)').run(10, 1);
  db.prepare('INSERT INTO wp_term_relationships VALUES (?,?)').run(10, 2);

  db.prepare('INSERT INTO wp_options (option_name, option_value) VALUES (?,?)').run(
    'blogname',
    'Roll Along'
  );
  db.prepare('INSERT INTO wp_options (option_name, option_value) VALUES (?,?)').run(
    'blogdescription',
    'A Travel Adventure'
  );
  db.prepare('INSERT INTO wp_options (option_name, option_value) VALUES (?,?)').run(
    'siteurl',
    'https://wp.example'
  );

  const insertComment = db.prepare(
    'INSERT INTO wp_comments (comment_ID, comment_post_ID, comment_author, comment_author_url, comment_date, comment_content, comment_approved, comment_parent) VALUES (?,?,?,?,?,?,?,?)'
  );
  insertComment.run(1, 10, 'Ann', '', '2026-05-19 00:00:00', 'Nice!', '1', 0);
  insertComment.run(2, 10, 'Bot', 'http://spam', '2026-05-19 00:00:00', 'Buy now', 'spam', 0);
  insertComment.run(3, 10, 'Held', '', '2026-05-19 00:00:00', 'Pending', '0', 0);

  db.close();
  const uploadsRoot = path.join(root, 'uploads');
  fs.mkdirSync(path.join(uploadsRoot, '2026', '05'), { recursive: true });
  fs.writeFileSync(path.join(uploadsRoot, '2026', '05', 'p.jpeg'), 'IMG');
  return { dbPath, uploadsRoot };
}

test('listPosts: published only by default, newest first', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const r = await src.listPosts();
  assert.equal(r.total, 1);
  assert.equal(r.totalPages, 1);
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0]?.slug, 'one-final-day');
});

test('listPosts: status draft and any', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  assert.equal((await src.listPosts({ status: 'draft' })).total, 1);
  assert.equal((await src.listPosts({ status: 'any' })).total, 2);
});

test('listPosts: paginates', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const r = await src.listPosts({ status: 'any', perPage: 1, page: 2 });
  assert.equal(r.total, 2);
  assert.equal(r.totalPages, 2);
  assert.equal(r.posts.length, 1);
});

test('listPosts: posts sharing a post_date are each returned once across pages', async (t) => {
  const fix = backup(t);
  const db = open(fix.dbPath);
  const insert = db.prepare(
    'INSERT INTO wp_posts (ID, post_date, post_content, post_title, post_excerpt, post_status, post_name, post_modified, post_type) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  for (const id of [15, 16]) {
    insert.run(
      id,
      '2026-05-20 00:00:00',
      '<p>x</p>',
      `Tied ${id}`,
      '',
      'publish',
      `tied-${id}`,
      '2026-05-20 00:00:00',
      'post'
    );
  }
  db.close();
  const src = sqliteSource(fix);
  t.after(() => src.close());

  const seen: number[] = [];
  for (const page of [1, 2, 3]) {
    const r = await src.listPosts({ perPage: 1, page });
    assert.equal(r.total, 3);
    assert.equal(r.posts.length, 1);
    seen.push(r.posts[0]?.id ?? 0);
  }
  assert.deepEqual(seen, [16, 15, 10]);
});

test('listPosts: clamps an out-of-range perPage', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  assert.equal((await src.listPosts({ status: 'any', perPage: 0 })).totalPages, 2);
  assert.equal((await src.listPosts({ status: 'any', perPage: 9000 })).totalPages, 1);
});

test('fetchPost: maps every field the importer reads', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const post = await src.fetchPost('one-final-day');
  assert.equal(post.id, 10);
  assert.equal(post.title.rendered, 'One final day');
  assert.equal(post.excerpt.rendered, 'Excerpt here');
  assert.equal(post.status, 'publish');
  assert.equal(post.date, '2026-05-18T21:27:39');
  assert.equal(post.modified, '2026-05-19T08:00:00');
  assert.equal(post.link, 'https://wp.example/one-final-day');
  assert.equal(post.featured_media, 77);
  assert.deepEqual(post.tags, [1]);
  assert.deepEqual(post.categories, [2]);
});

test('fetchPost: by numeric id', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  assert.equal((await src.fetchPost(10)).slug, 'one-final-day');
});

test('fetchPost: by numeric id given as a string', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  assert.equal((await src.fetchPost('10')).slug, 'one-final-day');
});

test('fetchPost: throws for a numeric id that is not a post', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  await assert.rejects(() => src.fetchPost(12), /no post/);
  await assert.rejects(() => src.fetchPost(77), /no post/);
});

test('fetchPost: throws for an unknown slug', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  await assert.rejects(() => src.fetchPost('nope'), /no post/);
});

test('fetchPost: annotates img src with the attachment id', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const post = await src.fetchPost('one-final-day');
  assert.match(post.content.rendered, /p-768x1024\.jpeg#wp-image-77"/);
});

test('slug falls back to the slugified title when post_name is empty', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const drafts = await src.listPosts({ status: 'draft' });
  assert.equal(drafts.posts[0]?.slug, 'a-few-days-in-stirling-scotland');
});

test('slug falls back to post-<id> when the title yields nothing', async (t) => {
  const fix = backup(t);
  const db = open(fix.dbPath);
  db.prepare(
    'INSERT INTO wp_posts (ID, post_date, post_content, post_title, post_excerpt, post_status, post_name, post_modified, post_type) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    13,
    '2026-07-01 00:00:00',
    '<p>x</p>',
    '???',
    '',
    'draft',
    '',
    '2026-07-01 00:00:00',
    'post'
  );
  db.close();
  const src = sqliteSource(fix);
  t.after(() => src.close());
  assert.equal((await src.fetchPost(13)).slug, 'post-13');
});

test('images without a wp-image class are left alone', async (t) => {
  const fix = backup(t);
  const db = open(fix.dbPath);
  db.prepare(
    'INSERT INTO wp_posts (ID, post_date, post_content, post_title, post_excerpt, post_status, post_name, post_modified, post_type) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    14,
    '2026-07-02 00:00:00',
    '<img src="https://wp.example/a.jpeg"/>',
    'Plain',
    '',
    'draft',
    'plain',
    '2026-07-02 00:00:00',
    'post'
  );
  db.close();
  const src = sqliteSource(fix);
  t.after(() => src.close());
  assert.equal(
    (await src.fetchPost(14)).content.rendered,
    '<img src="https://wp.example/a.jpeg"/>'
  );
});

test('fetchTagNames resolves names from wp_terms', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  assert.deepEqual(await src.fetchTagNames([1], 'https://wp.example/one-final-day'), ['Scotland']);
  assert.deepEqual(await src.fetchTagNames([], 'https://wp.example/one-final-day'), []);
});

test('fetchPage returns a WP page by slug', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const page = await src.fetchPage('about');
  assert.equal(page.id, 12);
  assert.equal(page.title.rendered, 'About');
  await assert.rejects(() => src.fetchPage('missing'), /no page/);
});

test('fetchSiteInfo reads blogname and blogdescription', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  assert.deepEqual(await src.fetchSiteInfo(), {
    name: 'Roll Along',
    description: 'A Travel Adventure'
  });
});

test('fetchFeaturedMediaUrl builds a URL the image fetcher can resolve', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const url = await src.fetchFeaturedMediaUrl(77);
  assert.equal(url, 'https://wp.example/wp-content/uploads/2026/05/p.jpeg#wp-image-77');
  assert.equal(await src.fetchFeaturedMediaUrl(0), null);
  assert.equal(await src.fetchFeaturedMediaUrl(4242), null);
});

test('a trailing slash on siteurl is trimmed, a missing one yields no host', async (t) => {
  const fix = backup(t);
  const db = open(fix.dbPath);
  db.prepare('UPDATE wp_options SET option_value = ? WHERE option_name = ?').run(
    'https://wp.example/',
    'siteurl'
  );
  db.prepare('DELETE FROM wp_options WHERE option_name = ?').run('blogdescription');
  db.close();
  const src = sqliteSource(fix);
  t.after(() => src.close());
  assert.equal((await src.fetchPost(10)).link, 'https://wp.example/one-final-day');
  assert.equal((await src.fetchSiteInfo()).description, '');
});

test('fetchSiteBannerUrl picks the newest cropped- attachment', async (t) => {
  const fix = backup(t);
  const db = open(fix.dbPath);
  db.prepare(
    'INSERT INTO wp_posts (ID, post_date, post_title, post_status, post_name, post_type) VALUES (?,?,?,?,?,?)'
  ).run(88, '2026-06-01 00:00:00', 'banner', 'inherit', 'banner', 'attachment');
  db.prepare('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?,?,?)').run(
    88,
    '_wp_attached_file',
    '2026/06/cropped-header.jpeg'
  );
  db.close();
  const src = sqliteSource(fix);
  t.after(() => src.close());
  assert.equal(
    await src.fetchSiteBannerUrl(),
    'https://wp.example/wp-content/uploads/2026/06/cropped-header.jpeg#wp-image-88'
  );
});

function setOptions(dbPath: string, options: Record<string, string>): void {
  const db = open(dbPath);
  const insert = db.prepare('INSERT INTO wp_options (option_name, option_value) VALUES (?,?)');
  const update = db.prepare('UPDATE wp_options SET option_value = ? WHERE option_name = ?');
  for (const [name, value] of Object.entries(options)) {
    if (update.run(value, name).changes === 0) insert.run(name, value);
  }
  db.close();
}

test('link follows a date-based permalink_structure', async (t) => {
  const fix = backup(t);
  setOptions(fix.dbPath, { permalink_structure: '/%year%/%monthnum%/%day%/%postname%/' });
  const src = sqliteSource(fix);
  t.after(() => src.close());
  assert.equal((await src.fetchPost(10)).link, 'https://wp.example/2026/05/18/one-final-day/');
});

test('link resolves the time and %post_id% tags', async (t) => {
  const fix = backup(t);
  setOptions(fix.dbPath, {
    permalink_structure: '/%hour%%minute%%second%/%post_id%-%postname%'
  });
  const src = sqliteSource(fix);
  t.after(() => src.close());
  assert.equal((await src.fetchPost(10)).link, 'https://wp.example/212739/10-one-final-day');
});

test('link falls back to <base>/<slug> for an unsupported tag', async (t) => {
  const fix = backup(t);
  setOptions(fix.dbPath, { permalink_structure: '/%category%/%postname%/' });
  const src = sqliteSource(fix);
  t.after(() => src.close());
  assert.equal((await src.fetchPost(10)).link, 'https://wp.example/one-final-day');
});

test('link falls back when the structure holds no tags', async (t) => {
  const fix = backup(t);
  setOptions(fix.dbPath, { permalink_structure: '/archives/' });
  const src = sqliteSource(fix);
  t.after(() => src.close());
  assert.equal((await src.fetchPost(10)).link, 'https://wp.example/one-final-day');
});

test('link falls back on WP’s zero post_date', async (t) => {
  const fix = backup(t);
  setOptions(fix.dbPath, { permalink_structure: '/%year%/%postname%/' });
  const db = open(fix.dbPath);
  db.prepare('UPDATE wp_posts SET post_date = ? WHERE ID = ?').run('0000-00-00 00:00:00', 10);
  db.close();
  const src = sqliteSource(fix);
  t.after(() => src.close());
  assert.equal((await src.fetchPost(10)).link, 'https://wp.example/one-final-day');
});

test('link is built from home, not siteurl, when both are set', async (t) => {
  const fix = backup(t);
  setOptions(fix.dbPath, {
    home: 'https://blog.example/',
    siteurl: 'https://wp.example/cms',
    permalink_structure: '/%year%/%monthnum%/%day%/%postname%/'
  });
  const src = sqliteSource(fix);
  t.after(() => src.close());
  const post = await src.fetchPost(10);
  assert.equal(post.link, 'https://blog.example/2026/05/18/one-final-day/');
  assert.equal(
    await src.fetchFeaturedMediaUrl(77),
    'https://wp.example/cms/wp-content/uploads/2026/05/p.jpeg#wp-image-77'
  );
});

test('annotateImages ignores a data-src attribute before the real src', async (t) => {
  const fix = backup(t);
  const db = open(fix.dbPath);
  db.prepare(
    'INSERT INTO wp_posts (ID, post_date, post_content, post_title, post_excerpt, post_status, post_name, post_modified, post_type) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    18,
    '2026-07-03 00:00:00',
    '<img data-src="https://wp.example/lazy.jpeg" class="wp-image-77" src="https://wp.example/wp-content/uploads/2026/05/p-768x1024.jpeg"/>',
    'Lazy',
    '',
    'draft',
    'lazy',
    '2026-07-03 00:00:00',
    'post'
  );
  db.close();
  const src = sqliteSource(fix);
  t.after(() => src.close());
  const html = (await src.fetchPost(18)).content.rendered;
  assert.match(html, /data-src="https:\/\/wp\.example\/lazy\.jpeg"/);
  assert.match(html, / src="[^"]*p-768x1024\.jpeg#wp-image-77"/);
});

test('fetchSiteBannerUrl ignores cropped- in the middle of a filename', async (t) => {
  const fix = backup(t);
  const db = open(fix.dbPath);
  const insertAttachment = db.prepare(
    'INSERT INTO wp_posts (ID, post_date, post_title, post_status, post_name, post_type) VALUES (?,?,?,?,?,?)'
  );
  const insertMeta = db.prepare(
    'INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?,?,?)'
  );
  insertAttachment.run(88, '2026-06-01 00:00:00', 'banner', 'inherit', 'banner', 'attachment');
  insertMeta.run(88, '_wp_attached_file', '2026/06/cropped-header.jpeg');
  insertAttachment.run(89, '2026-07-01 00:00:00', 'kayak', 'inherit', 'kayak', 'attachment');
  insertMeta.run(89, '_wp_attached_file', '2024/04/KayakingCropped-scaled.jpeg');
  db.close();
  const src = sqliteSource(fix);
  t.after(() => src.close());
  assert.equal(
    await src.fetchSiteBannerUrl(),
    'https://wp.example/wp-content/uploads/2026/06/cropped-header.jpeg#wp-image-88'
  );
});

test('fetchSiteBannerUrl returns null when no cropped- attachment exists', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  assert.equal(await src.fetchSiteBannerUrl(), null);
});

test('listComments returns approved only, in WpComment shape', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const r = await src.listComments();
  assert.equal(r.total, 1);
  assert.equal(r.totalPages, 1);
  assert.equal(r.comments.length, 1);
  assert.deepEqual(r.comments[0], {
    id: 1,
    post: 10,
    parent: 0,
    author_name: 'Ann',
    author_url: '',
    date: '2026-05-19T00:00:00',
    content: { rendered: 'Nice!' }
  });
});

test('listComments excludes an approved trackback or pingback', async (t) => {
  const fix = backup(t);
  const db = open(fix.dbPath);
  const insert = db.prepare(
    'INSERT INTO wp_comments (comment_ID, comment_post_ID, comment_author, comment_author_url, comment_date, comment_content, comment_approved, comment_type, comment_parent) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  insert.run(7, 10, 'Site', 'http://tb', '2026-05-19 00:00:00', 'Trackback', '1', 'trackback', 0);
  insert.run(8, 10, 'Site', 'http://pb', '2026-05-19 00:00:00', 'Pingback', '1', 'pingback', 0);
  db.close();
  const src = sqliteSource(fix);
  t.after(() => src.close());
  const r = await src.listComments();
  assert.equal(r.total, 1);
  assert.deepEqual(
    r.comments.map((c) => c.id),
    [1]
  );
});

test('listComments paginates', async (t) => {
  const fix = backup(t);
  const db = open(fix.dbPath);
  db.prepare(
    'INSERT INTO wp_comments (comment_ID, comment_post_ID, comment_author, comment_author_url, comment_date, comment_content, comment_approved, comment_parent) VALUES (?,?,?,?,?,?,?,?)'
  ).run(4, 10, 'Bea', '', '2026-05-20 00:00:00', 'Second', '1', 1);
  db.close();
  const src = sqliteSource(fix);
  t.after(() => src.close());
  const r = await src.listComments({ page: 2, perPage: 1 });
  assert.equal(r.total, 2);
  assert.equal(r.totalPages, 2);
  assert.equal(r.comments[0]?.id, 4);
});

test('listComments: comments sharing a comment_date are each returned once across pages', async (t) => {
  const fix = backup(t);
  const db = open(fix.dbPath);
  const insert = db.prepare(
    'INSERT INTO wp_comments (comment_ID, comment_post_ID, comment_author, comment_author_url, comment_date, comment_content, comment_approved, comment_parent) VALUES (?,?,?,?,?,?,?,?)'
  );
  insert.run(5, 10, 'Cal', '', '2026-05-19 00:00:00', 'Tied one', '1', 0);
  insert.run(6, 10, 'Dot', '', '2026-05-19 00:00:00', 'Tied two', '1', 0);
  db.close();
  const src = sqliteSource(fix);
  t.after(() => src.close());

  const seen: number[] = [];
  for (const page of [1, 2, 3]) {
    const r = await src.listComments({ perPage: 1, page });
    assert.equal(r.total, 3);
    assert.equal(r.comments.length, 1);
    seen.push(r.comments[0]?.id ?? 0);
  }
  assert.deepEqual(seen, [1, 5, 6]);
});

test('fetchImage streams the original from the uploads tree', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const stream = await src.fetchImage(
    'https://wp.example/wp-content/uploads/2026/05/p-768x1024.jpeg#wp-image-77'
  );
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  assert.equal(Buffer.concat(chunks).toString(), 'IMG');
});
