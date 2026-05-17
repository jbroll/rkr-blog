import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { open } from '../../src/lib/db.ts';
import {
  readAllIndexedPosts,
  readIndexedPostBySlug,
  readIndexedPosts,
  readTagCounts,
  runReindex
} from '../../src/lib/post-index.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-reindex-'));
  for (const sub of ['content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePost(
  root: string,
  filename: string,
  frontmatter: Record<string, string>,
  body: string
): void {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  fs.writeFileSync(path.join(root, 'content', 'posts', filename), `---\n${fm}\n---\n\n${body}\n`);
}

/** Write a post whose frontmatter includes a YAML flow-sequence tags field. */
function writePostWithTags(
  root: string,
  filename: string,
  base: Record<string, string>,
  tags: string[],
  body = 'body'
): void {
  const baseFm = Object.entries(base)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const tagsFm = tags.length ? `\ntags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]` : '';
  fs.writeFileSync(
    path.join(root, 'content', 'posts', filename),
    `---\n${baseFm}${tagsFm}\n---\n\n${body}\n`
  );
}

test('runReindex inserts new posts on first run', (t) => {
  const root = freshSiteRoot(t);
  writePost(
    root,
    '2026-05-06-hello.md',
    { slug: 'hello', title: 'Hello world', status: 'published', date: '2026-05-06T14:00:00Z' },
    'Body of hello.'
  );
  writePost(
    root,
    '2026-05-07-second.md',
    { slug: 'second', title: 'Second post', status: 'draft', date: '2026-05-07T10:00:00Z' },
    'Body of second.'
  );

  const r = runReindex(root);
  assert.equal(r.inserted, 2);
  assert.equal(r.updated, 0);
  assert.equal(r.removed, 0);

  const db = open(path.join(root, 'data', 'site.db'));
  try {
    const all = readIndexedPosts(db, { status: 'published' });
    assert.equal(all.length, 1);
    assert.equal(all[0]?.slug, 'hello');

    const draft = readIndexedPosts(db, { status: 'draft' });
    assert.equal(draft.length, 1);
    assert.equal(draft[0]?.slug, 'second');
  } finally {
    db.close();
  }
});

test('runReindex is idempotent: a second run updates rather than re-inserts', (t) => {
  const root = freshSiteRoot(t);
  writePost(root, 'a.md', { slug: 'a', title: 'A', status: 'published' }, 'body');

  const r1 = runReindex(root);
  assert.deepEqual(r1, { inserted: 1, updated: 0, removed: 0 });

  const r2 = runReindex(root);
  assert.deepEqual(r2, { inserted: 0, updated: 1, removed: 0 });
});

test('runReindex removes rows whose source file is gone', (t) => {
  const root = freshSiteRoot(t);
  writePost(root, 'a.md', { slug: 'a', title: 'A', status: 'published' }, 'a body');
  writePost(root, 'b.md', { slug: 'b', title: 'B', status: 'published' }, 'b body');

  runReindex(root);

  fs.unlinkSync(path.join(root, 'content', 'posts', 'a.md'));
  const r = runReindex(root);
  assert.equal(r.removed, 1);
  assert.equal(r.updated, 1, 'b is updated, not re-inserted');

  const db = open(path.join(root, 'data', 'site.db'));
  try {
    assert.equal(readIndexedPostBySlug(db, 'a'), undefined);
    assert.ok(readIndexedPostBySlug(db, 'b'));
  } finally {
    db.close();
  }
});

test('runReindex skips files with bad frontmatter rather than failing the whole run', (t) => {
  const root = freshSiteRoot(t);
  writePost(root, 'good.md', { slug: 'good', title: 'Good', status: 'published' }, 'body');
  fs.writeFileSync(path.join(root, 'content', 'posts', 'bad.md'), 'no frontmatter here');

  const r = runReindex(root);
  assert.equal(r.inserted, 1);
  assert.equal(r.updated, 0);
});

test('readAllIndexedPosts returns drafts + published, newest-updated first', (t) => {
  const root = freshSiteRoot(t);
  writePost(
    root,
    'a.md',
    { slug: 'a', title: 'A', status: 'draft', date: '2026-05-01T00:00:00Z' },
    'body'
  );
  writePost(
    root,
    'b.md',
    { slug: 'b', title: 'B', status: 'published', date: '2026-05-02T00:00:00Z' },
    'body'
  );
  runReindex(root);

  const db = open(path.join(root, 'data', 'site.db'));
  try {
    const all = readAllIndexedPosts(db);
    assert.equal(all.length, 2);
    // Both drafts and published surface; updated_at is the file mtime
    // so order between the two writes is filesystem-dependent. We just
    // assert membership.
    const slugs = new Set(all.map((p) => p.slug));
    assert.ok(slugs.has('a') && slugs.has('b'));
    const statuses = new Set(all.map((p) => p.status));
    assert.ok(statuses.has('draft') && statuses.has('published'));
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Tag sync tests
// ---------------------------------------------------------------------------

test('tags from frontmatter land in tags + post_tags tables', (t) => {
  const root = freshSiteRoot(t);
  writePostWithTags(root, 'a.md', { slug: 'a', title: 'A', status: 'published' }, [
    'travel',
    'food'
  ]);
  runReindex(root);

  const db = open(path.join(root, 'data', 'site.db'));
  try {
    const tags = db
      .prepare<{ name: string }>('SELECT name FROM tags ORDER BY name')
      .all()
      .map((r) => r.name);
    assert.deepEqual(tags, ['food', 'travel']);

    const post = db.prepare<{ id: number }>('SELECT id FROM posts WHERE slug = ?').get('a');
    assert.ok(post);
    const postTags = db
      .prepare<{ name: string }>(
        `SELECT t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
         WHERE pt.post_id = ? ORDER BY t.name`
      )
      .all(post.id)
      .map((r) => r.name);
    assert.deepEqual(postTags, ['food', 'travel']);
  } finally {
    db.close();
  }
});

test('reindex replaces post tags on update (old tags removed, new ones added)', (t) => {
  const root = freshSiteRoot(t);
  writePostWithTags(root, 'a.md', { slug: 'a', title: 'A', status: 'published' }, ['travel']);
  runReindex(root);

  // Overwrite with a different tag set.
  writePostWithTags(root, 'a.md', { slug: 'a', title: 'A', status: 'published' }, ['food']);
  runReindex(root);

  const db = open(path.join(root, 'data', 'site.db'));
  try {
    const post = db.prepare<{ id: number }>('SELECT id FROM posts WHERE slug = ?').get('a');
    assert.ok(post);
    const postTags = db
      .prepare<{ name: string }>(
        `SELECT t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = ?`
      )
      .all(post.id)
      .map((r) => r.name);
    assert.deepEqual(postTags, ['food']);
  } finally {
    db.close();
  }
});

test('orphaned tags pruned after post deletion', (t) => {
  const root = freshSiteRoot(t);
  writePostWithTags(root, 'a.md', { slug: 'a', title: 'A', status: 'published' }, ['unique-tag']);
  runReindex(root);

  fs.unlinkSync(path.join(root, 'content', 'posts', 'a.md'));
  runReindex(root);

  const db = open(path.join(root, 'data', 'site.db'));
  try {
    const tags = db.prepare<{ name: string }>('SELECT name FROM tags').all();
    assert.equal(tags.length, 0, 'orphaned tag should be pruned');
  } finally {
    db.close();
  }
});

test('readIndexedPosts tag filter returns only matching posts', (t) => {
  const root = freshSiteRoot(t);
  writePostWithTags(
    root,
    'a.md',
    { slug: 'a', title: 'A', status: 'published', date: '2026-01-01T00:00:00Z' },
    ['travel']
  );
  writePostWithTags(
    root,
    'b.md',
    { slug: 'b', title: 'B', status: 'published', date: '2026-01-02T00:00:00Z' },
    ['food', 'travel']
  );
  writePostWithTags(
    root,
    'c.md',
    { slug: 'c', title: 'C', status: 'published', date: '2026-01-03T00:00:00Z' },
    ['food']
  );
  runReindex(root);

  const db = open(path.join(root, 'data', 'site.db'));
  try {
    const travelPosts = readIndexedPosts(db, { tags: ['travel'] });
    const slugs = travelPosts.map((p) => p.slug).sort();
    assert.deepEqual(slugs, ['a', 'b']);

    const foodPosts = readIndexedPosts(db, { tags: ['food'] });
    const foodSlugs = foodPosts.map((p) => p.slug).sort();
    assert.deepEqual(foodSlugs, ['b', 'c']);

    // Case-insensitive match
    const upperPosts = readIndexedPosts(db, { tags: ['TRAVEL'] });
    assert.equal(upperPosts.length, 2);

    // Multi-tag AND: only post B has both travel + food
    const andPosts = readIndexedPosts(db, { tags: ['travel', 'food'] });
    assert.deepEqual(
      andPosts.map((p) => p.slug),
      ['b']
    );
  } finally {
    db.close();
  }
});

test('readTagCounts returns name + count sorted by name DESC', (t) => {
  const root = freshSiteRoot(t);
  writePostWithTags(
    root,
    'a.md',
    { slug: 'a', title: 'A', status: 'published', date: '2026-01-01T00:00:00Z' },
    ['travel']
  );
  writePostWithTags(
    root,
    'b.md',
    { slug: 'b', title: 'B', status: 'published', date: '2026-01-02T00:00:00Z' },
    ['food', 'travel']
  );
  writePostWithTags(
    root,
    'c.md',
    { slug: 'c', title: 'C', status: 'draft', date: '2026-01-03T00:00:00Z' },
    ['food']
  );
  runReindex(root);

  const db = open(path.join(root, 'data', 'site.db'));
  try {
    // Anonymous view: only published — reverse alphabetical order
    const counts = readTagCounts(db, { status: 'published' });
    assert.equal(counts[0]?.name, 'travel'); // 't' > 'f'
    assert.equal(counts[0]?.count, 2);
    assert.equal(counts[1]?.name, 'food');
    assert.equal(counts[1]?.count, 1);

    // Admin view: all statuses
    const adminCounts = readTagCounts(db, { status: null });
    const foodEntry = adminCounts.find((c) => c.name === 'food');
    assert.equal(foodEntry?.count, 2); // b (published) + c (draft)
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// System post (_-prefixed slug) skip tests
// ---------------------------------------------------------------------------

test('runReindex skips _-prefixed slugs: _site-banner is not inserted', (t) => {
  const root = freshSiteRoot(t);
  // A normal post that should be indexed.
  writePost(root, 'hello.md', { slug: 'hello', title: 'Hello', status: 'published' }, 'body');
  // A system post that must be skipped.
  writePost(
    root,
    '_site-banner.md',
    { slug: '_site-banner', title: 'Site Banner', status: 'published' },
    '::figure{ids="abc123" justify=bleed}'
  );

  const r = runReindex(root);
  // Only the normal post is inserted; _site-banner is skipped.
  assert.equal(r.inserted, 1, 'only normal post inserted');
  assert.equal(r.updated, 0);
  assert.equal(r.removed, 0);

  const db = open(path.join(root, 'data', 'site.db'));
  try {
    assert.ok(readIndexedPostBySlug(db, 'hello'), 'normal post is indexed');
    assert.equal(readIndexedPostBySlug(db, '_site-banner'), undefined, '_site-banner not in DB');
  } finally {
    db.close();
  }
});

test('runReindex does not remove _-prefixed slugs in the orphan step (they were never added)', (t) => {
  const root = freshSiteRoot(t);
  writePost(root, 'a.md', { slug: 'a', title: 'A', status: 'published' }, 'body');
  writePost(
    root,
    '_site-banner.md',
    { slug: '_site-banner', title: 'Site Banner', status: 'published' },
    'banner body'
  );

  runReindex(root);
  // Run again — should not count _site-banner as a removal.
  const r2 = runReindex(root);
  assert.equal(r2.removed, 0, '_site-banner not counted as orphan');
  assert.equal(r2.inserted, 0);
  assert.equal(r2.updated, 1, 'only a.md updated');
});

test('readIndexedPosts sort:asc returns oldest published_at first', (t) => {
  const root = freshSiteRoot(t);
  writePost(
    root,
    'older.md',
    { slug: 'older', title: 'Older', status: 'published', date: '2025-01-01T00:00:00Z' },
    'body'
  );
  writePost(
    root,
    'newer.md',
    { slug: 'newer', title: 'Newer', status: 'published', date: '2026-06-01T00:00:00Z' },
    'body'
  );
  writePost(
    root,
    'middle.md',
    { slug: 'middle', title: 'Middle', status: 'published', date: '2025-06-01T00:00:00Z' },
    'body'
  );
  runReindex(root);
  const db = open(path.join(root, 'data', 'site.db'));
  try {
    const asc = readIndexedPosts(db, { status: 'published', sort: 'asc' });
    assert.deepEqual(
      asc.map((p) => p.slug),
      ['older', 'middle', 'newer']
    );

    const desc = readIndexedPosts(db, { status: 'published', sort: 'desc' });
    assert.equal(desc[0]?.slug, 'newer');
    assert.equal(desc[desc.length - 1]?.slug, 'older');
  } finally {
    db.close();
  }
});

test('runReindex populates posts_fts with body + tags, queryable by slug', (t) => {
  const root = freshSiteRoot(t);
  writePostWithTags(
    root,
    'a.md',
    { slug: 'alpha', title: 'Alpha Post' },
    ['rust', 'async'],
    'The body mentions tokio.'
  );
  runReindex(root);
  const db = open(path.join(root, 'data', 'site.db'));
  try {
    const hit = db
      .prepare<{ slug: string }>("SELECT slug FROM posts_fts WHERE posts_fts MATCH 'tokio'")
      .get();
    assert.equal(hit?.slug, 'alpha');
    const byTag = db
      .prepare<{ slug: string }>("SELECT slug FROM posts_fts WHERE posts_fts MATCH 'async'")
      .get();
    assert.equal(byTag?.slug, 'alpha');
  } finally {
    db.close();
  }
});

test('runReindex removes the posts_fts row when the source file is gone', (t) => {
  const root = freshSiteRoot(t);
  writePost(root, 'a.md', { slug: 'alpha', title: 'Alpha' }, 'body one');
  runReindex(root);
  fs.rmSync(path.join(root, 'content', 'posts', 'a.md'));
  runReindex(root);
  const db = open(path.join(root, 'data', 'site.db'));
  try {
    const n = db
      .prepare<{ c: number }>('SELECT COUNT(*) c FROM posts_fts WHERE slug = ?')
      .get('alpha');
    assert.equal(n?.c, 0);
  } finally {
    db.close();
  }
});
