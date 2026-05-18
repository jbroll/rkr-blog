// Tests for tags roundtrip through POST /admin/posts frontmatter.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { buildApp } from '../../src/server.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-save-tags-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function setup(t: TestContext) {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root, startWorker: false });
  t.after(() => app.close());
  return { root, app };
}

function readPost(root: string, slug: string): string {
  return fs.readFileSync(path.join(root, 'content', 'posts', `${slug}.md`), 'utf8');
}

test('POST /admin/posts: tags roundtrip through frontmatter', async (t) => {
  const { root, app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      title: 'Tag Test',
      slug: 'tag-test',
      markdown: 'Hello world.',
      tags: ['travel', 'food']
    }
  });
  assert.equal(res.statusCode, 200);
  const md = readPost(root, 'tag-test');
  assert.match(md, /^tags:/m);
  assert.match(md, /- travel/);
  assert.match(md, /- food/);
});

test('POST /admin/posts: invalid tag entries stripped (non-string, too long, blank)', async (t) => {
  const { root, app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      title: 'Strip Test',
      slug: 'strip-test',
      markdown: 'Hello.',
      // 42 (non-string), '' (blank), 'x'.repeat(33) (too long), 'valid'
      tags: [42, '', 'x'.repeat(33), 'valid']
    }
  });
  assert.equal(res.statusCode, 200);
  const md = readPost(root, 'strip-test');
  assert.match(md, /- valid/);
  assert.doesNotMatch(md, /- {33,}/); // long tag not present
  // only valid tag in the list
  const tagBlock = md.match(/^tags:\n((?:- .+\n?)*)/m);
  assert.ok(tagBlock?.[1], 'tags block present');
  assert.equal(tagBlock[1].trim(), '- valid');
});

test('POST /admin/posts: duplicate tags deduplicated (case-preserving first occurrence)', async (t) => {
  const { root, app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      title: 'Dedup Test',
      slug: 'dedup-test',
      markdown: 'Hello.',
      tags: ['Travel', 'travel', 'TRAVEL', 'food']
    }
  });
  assert.equal(res.statusCode, 200);
  const md = readPost(root, 'dedup-test');
  // Only first occurrence kept (Travel), food kept
  const matches = [...md.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
  assert.equal(matches.length, 2);
  assert.ok(matches.includes('Travel'));
  assert.ok(matches.includes('food'));
});

test('POST /admin/posts: tags capped at 20', async (t) => {
  const { root, app } = await setup(t);
  const many = Array.from({ length: 25 }, (_, i) => `tag${i}`);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { title: 'Cap Test', slug: 'cap-test', markdown: 'Hello.', tags: many }
  });
  assert.equal(res.statusCode, 200);
  const md = readPost(root, 'cap-test');
  const count = [...md.matchAll(/^- tag\d+$/gm)].length;
  assert.equal(count, 20);
});

test('POST /admin/posts: no tags field → no tags in frontmatter', async (t) => {
  const { root, app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { title: 'No Tags', slug: 'no-tags', markdown: 'Hello.' }
  });
  assert.equal(res.statusCode, 200);
  const md = readPost(root, 'no-tags');
  assert.doesNotMatch(md, /^tags:/m);
});

test('POST /admin/posts: empty tags array → no tags in frontmatter', async (t) => {
  const { root, app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { title: 'Empty Tags', slug: 'empty-tags', markdown: 'Hello.', tags: [] }
  });
  assert.equal(res.statusCode, 200);
  const md = readPost(root, 'empty-tags');
  assert.doesNotMatch(md, /^tags:/m);
});
