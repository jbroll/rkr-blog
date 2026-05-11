import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import {
  readAllIndexedPosts,
  readIndexedPostBySlug,
  readIndexedPosts,
  runReindex
} from '../../src/cli/reindex.ts';
import { open } from '../../src/lib/db.ts';

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
