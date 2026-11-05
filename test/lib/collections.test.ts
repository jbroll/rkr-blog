import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import {
  collectionNav,
  collectionOf,
  memberExclusionSql,
  NON_COLLECTION_SLUGS,
  pagePath
} from '../../src/lib/collections.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { runReindex } from '../../src/lib/post-index.ts';

function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-collections-'));
  for (const sub of ['content/posts', 'content/blocks', 'data', 'macros']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const page = (slug: string, fields: Record<string, unknown> = {}) => {
    fs.writeFileSync(
      path.join(root, 'content', 'blocks', `${slug}.json`),
      JSON.stringify({
        version: 1,
        body: [],
        fields: { title: `T ${slug}`, slug, status: 'published', kind: 'page', ...fields }
      })
    );
  };
  return { db, page, reindex: () => runReindex(root) };
}

test('a published page whose slug matches a tag makes a collection', (t) => {
  const { db, page, reindex } = setup(t);
  page('board', { title: 'The Board' });
  page('alice', { tags: ['board'] });
  reindex();
  assert.deepEqual(collectionOf(db, 'alice'), { slug: 'board', title: 'The Board' });
  assert.equal(pagePath(db, 'alice'), '/board/alice');
  assert.equal(pagePath(db, 'board'), '/board');
});

test('tag Board matches page board; tag "Our Board" never does', (t) => {
  const { db, page, reindex } = setup(t);
  page('board');
  page('alice', { tags: ['Board'] });
  page('bob', { tags: ['Our Board'] });
  reindex();
  assert.equal(collectionOf(db, 'alice')?.slug, 'board');
  assert.equal(collectionOf(db, 'bob'), null);
});

test('draft collection page → collectionOf null', (t) => {
  const { db, page, reindex } = setup(t);
  page('board', { status: 'draft' });
  page('alice', { tags: ['board'] });
  reindex();
  assert.equal(collectionOf(db, 'alice'), null);
  assert.equal(pagePath(db, 'alice'), '/alice');
});

test('a kind post with the tag slug is not a collection', (t) => {
  const { db, page, reindex } = setup(t);
  page('board', { kind: 'post' });
  page('alice', { tags: ['board'] });
  reindex();
  assert.equal(collectionOf(db, 'alice'), null);
});

test('slug in NON_COLLECTION_SLUGS (img, posts) never collects; about does', (t) => {
  const { db, page, reindex } = setup(t);
  assert.ok(NON_COLLECTION_SLUGS.has('img'));
  assert.ok(NON_COLLECTION_SLUGS.has('posts'));
  assert.ok(!NON_COLLECTION_SLUGS.has('about'));
  page('img');
  page('about');
  page('a', { tags: ['img'] });
  page('b', { tags: ['posts'] });
  page('c', { tags: ['about'] });
  const err = console.error;
  console.error = () => {};
  try {
    page('posts');
    reindex();
  } finally {
    console.error = err;
  }
  assert.equal(collectionOf(db, 'a'), null);
  assert.equal(collectionOf(db, 'b'), null);
  assert.equal(collectionOf(db, 'c')?.slug, 'about');
});

test('the collection page tagged with its own tag is not its own member', (t) => {
  const { db, page, reindex } = setup(t);
  page('board', { tags: ['board'] });
  page('alice', { tags: ['board'] });
  reindex();
  assert.equal(collectionOf(db, 'board'), null);
  assert.deepEqual(collectionNav(db, 'alice')?.prev, null);
  assert.deepEqual(collectionNav(db, 'alice')?.next, null);
});

test('two collection tags → the first by position wins; pagePath uses it', (t) => {
  const { db, page, reindex } = setup(t);
  page('a');
  page('b');
  page('x', { tags: ['other', 'b', 'a'] });
  reindex();
  assert.equal(collectionOf(db, 'x')?.slug, 'b');
  assert.equal(pagePath(db, 'x'), '/b/x');
});

test('a draft member has a collection', (t) => {
  const { db, page, reindex } = setup(t);
  page('board');
  page('alice', { tags: ['board'], status: 'draft' });
  reindex();
  assert.equal(collectionOf(db, 'alice')?.slug, 'board');
});

test('nav orders by order then title, no wraparound, ends null', (t) => {
  const { db, page, reindex } = setup(t);
  page('board', { title: 'Board & Co' });
  page('z', { tags: ['board'], title: 'Zed', order: 1 });
  page('y', { tags: ['board'], title: 'Yan', order: 2 });
  page('a', { tags: ['board'], title: 'Abe' });
  page('b', { tags: ['board'], title: 'Bea' });
  reindex();
  const back = { path: '/board', title: 'Board & Co' };
  assert.deepEqual(collectionNav(db, 'z'), {
    back,
    prev: null,
    next: { path: '/board/y', title: 'Yan' }
  });
  assert.deepEqual(collectionNav(db, 'y'), {
    back,
    prev: { path: '/board/z', title: 'Zed' },
    next: { path: '/board/a', title: 'Abe' }
  });
  assert.deepEqual(collectionNav(db, 'b'), {
    back,
    prev: { path: '/board/a', title: 'Abe' },
    next: null
  });
  assert.equal(collectionNav(db, 'board'), null);
});

test('nav skips draft siblings', (t) => {
  const { db, page, reindex } = setup(t);
  page('board');
  page('a', { tags: ['board'], order: 1 });
  page('b', { tags: ['board'], order: 2, status: 'draft' });
  page('c', { tags: ['board'], order: 3 });
  reindex();
  assert.equal(collectionNav(db, 'a')?.next?.path, '/board/c');
  assert.equal(collectionNav(db, 'c')?.prev?.path, '/board/a');
  const draft = collectionNav(db, 'b');
  assert.equal(draft?.prev?.path, '/board/a');
  assert.equal(draft?.next?.path, '/board/c');
});

test('a page tagged with both A and B (A first) is absent from B nav', (t) => {
  const { db, page, reindex } = setup(t);
  page('ca');
  page('cb');
  page('m1', { tags: ['cb'], order: 1 });
  page('both', { tags: ['ca', 'cb'], order: 2 });
  page('m3', { tags: ['cb'], order: 3 });
  reindex();
  assert.equal(collectionNav(db, 'm1')?.next?.path, '/cb/m3');
  assert.equal(collectionNav(db, 'both')?.back.path, '/ca');
});

test('memberExclusionSql keeps non-members and drops members', (t) => {
  const { db, page, reindex } = setup(t);
  page('board');
  page('alice', { tags: ['board'] });
  page('loner', { tags: ['nothing'] });
  reindex();
  const slugs = db
    .prepare<{ slug: string }>(
      `SELECT slug FROM posts p WHERE ${memberExclusionSql('p')} ORDER BY slug`
    )
    .all()
    .map((r) => r.slug);
  assert.deepEqual(slugs, ['board', 'loner']);
});
