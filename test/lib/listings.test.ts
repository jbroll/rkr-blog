import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { listTaggedRows } from '../../src/lib/listings.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { runReindex } from '../../src/lib/post-index.ts';

function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-listings-'));
  for (const sub of ['content/posts', 'content/blocks', 'data', 'macros']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const page = (slug: string, fields: Record<string, unknown> = {}, body: unknown[] = []) => {
    fs.writeFileSync(
      path.join(root, 'content', 'blocks', `${slug}.json`),
      JSON.stringify({
        version: 1,
        body,
        fields: { title: `T ${slug}`, slug, status: 'published', kind: 'page', ...fields }
      })
    );
  };
  return { db, page, reindex: () => runReindex(root) };
}

const slugs = (rows: { href?: unknown }[]) => rows.map((r) => String(r.href).split('/').pop());

test('published rows only, tag matched case-insensitively', (t) => {
  const { db, page, reindex } = setup(t);
  page('a', { tags: ['Team'] });
  page('b', { tags: ['team'], status: 'draft' });
  page('c', { tags: ['other'] });
  reindex();
  assert.deepEqual(slugs(listTaggedRows(db, { tag: 'TEAM' })), ['a']);
});

test('the page itself is left out of its own listing', (t) => {
  const { db, page, reindex } = setup(t);
  page('board', { tags: ['board'] });
  page('alice', { tags: ['board'] });
  reindex();
  assert.deepEqual(slugs(listTaggedRows(db, { tag: 'board' }, 'board')), ['alice']);
});

test('order sorts by sort_order nulls last, then title', (t) => {
  const { db, page, reindex } = setup(t);
  page('x', { tags: ['g'], title: 'Zed', order: 2 });
  page('y', { tags: ['g'], title: 'Bee' });
  page('z', { tags: ['g'], title: 'Ant' });
  page('w', { tags: ['g'], title: 'Yak', order: 1 });
  reindex();
  assert.deepEqual(slugs(listTaggedRows(db, { tag: 'g' })), ['w', 'x', 'z', 'y']);
});

test('date sorts newest first', (t) => {
  const { db, page, reindex } = setup(t);
  page('old', { tags: ['g'], date: '2024-01-01' });
  page('new', { tags: ['g'], date: '2025-06-01' });
  reindex();
  assert.deepEqual(slugs(listTaggedRows(db, { tag: 'g', sort: 'date' })), ['new', 'old']);
});

test('limit caps the rows', (t) => {
  const { db, page, reindex } = setup(t);
  for (const s of ['a', 'b', 'c']) page(s, { tags: ['g'] });
  reindex();
  assert.equal(listTaggedRows(db, { tag: 'g', limit: 2 }).length, 2);
});

test('a row carries title, text, href, image and date', (t) => {
  const { db, page, reindex } = setup(t);
  page('board');
  page('alice', { tags: ['board'], title: 'Alice', excerpt: 'Hi there', date: '2025-06-01' }, [
    { type: 'figure', slots: { ids: 'aa11' } }
  ]);
  page('bob', { tags: ['board'], title: 'Bob' });
  reindex();
  const rows = listTaggedRows(db, { tag: 'board' }, 'board');
  const alice = rows.find((r) => r.title === 'Alice');
  assert.equal(alice?.href, '/board/alice');
  assert.equal(alice?.text, 'Hi there');
  assert.equal(alice?.image, 'aa11');
  assert.match(String(alice?.date), /2025/);
  const bob = rows.find((r) => r.title === 'Bob');
  assert.equal(bob?.text, '');
  assert.equal(bob?.image, '');
  assert.notEqual(bob?.date, '');
});
