import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { runReindex } from '../../src/lib/post-index.ts';

function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-listing-'));
  for (const sub of ['content/posts', 'content/blocks', 'data', 'macros']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const page = (slug: string, body: unknown[], fields: Record<string, unknown> = {}) => {
    fs.writeFileSync(
      path.join(root, 'content', 'blocks', `${slug}.json`),
      JSON.stringify({ version: 1, body, fields: { title: slug, slug, ...fields } })
    );
    runReindex(root);
  };
  const row = (slug: string) =>
    db
      .prepare<{
        excerpt: string | null;
        sort_order: number | null;
        image: string | null;
      }>('SELECT excerpt, sort_order, image FROM posts WHERE slug = ?')
      .get(slug);
  return { root, db, page, row };
}

test('reindex fills excerpt, sort_order and image for a block page', (t) => {
  const { page, row } = setup(t);
  page(
    'p',
    [
      {
        type: 'grid',
        slots: { cols: 1 },
        children: [{ type: 'figure', slots: { ids: 'aaa bbb' } }]
      }
    ],
    { excerpt: 'Hi', order: 2 }
  );
  assert.deepEqual(row('p'), { excerpt: 'Hi', sort_order: 2, image: 'aaa' });
});

test('image skips figures inside macro instances', (t) => {
  const { page, row } = setup(t);
  page('p', [
    { type: 'macro', macro: 'hero', slots: { image: 'zzz' } },
    { type: 'figure', slots: { ids: 'ccc' } }
  ]);
  assert.equal(row('p')?.image, 'ccc');
});

test('no figure, no excerpt, no order gives nulls', (t) => {
  const { page, row } = setup(t);
  page('p', [{ type: 'text', markdown: 'x' }]);
  assert.deepEqual(row('p'), { excerpt: null, sort_order: null, image: null });
});

test('markdown post leaves the new columns null', (t) => {
  const { root, row } = setup(t);
  fs.writeFileSync(
    path.join(root, 'content', 'posts', 'md.md'),
    '---\ntitle: MD\nslug: md\nstatus: published\n---\nBody\n'
  );
  runReindex(root);
  assert.deepEqual(row('md'), { excerpt: null, sort_order: null, image: null });
});

test('post_tags.position follows fields.tags order', (t) => {
  const { db, page } = setup(t);
  page('p', [], { tags: ['b', 'a'] });
  const rows = db
    .prepare<{ name: string; position: number }>(
      `SELECT t.name, pt.position FROM post_tags pt JOIN tags t ON t.id = pt.tag_id`
    )
    .all();
  const pos = Object.fromEntries(rows.map((r) => [r.name, r.position]));
  assert.deepEqual(pos, { b: 0, a: 1 });
});
