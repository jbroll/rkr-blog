// GET /?tag= filtering and tag rail on the public index.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { runReindex } from '../../src/cli/reindex.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { buildApp } from '../../src/server.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-pub-tag-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePostMd(
  root: string,
  slug: string,
  title: string,
  status: 'published' | 'draft',
  tags: string[] = []
): void {
  const tagsBlock = tags.length > 0 ? `tags:\n${tags.map((t) => `- ${t}`).join('\n')}\n` : '';
  const md = `---\ntitle: ${title}\nslug: ${slug}\ndate: 2026-01-01T00:00:00Z\nstatus: ${status}\n${tagsBlock}---\n\nBody text.\n`;
  fs.writeFileSync(path.join(root, 'content', 'posts', `${slug}.md`), md, 'utf8');
}

/** Write a minimal published post with optional tags. */
function writePost(root: string, slug: string, title: string, tags: string[] = []): void {
  writePostMd(root, slug, title, 'published', tags);
}

async function setup(t: TestContext) {
  const root = freshSiteRoot(t);
  writePost(root, 'post-travel', 'Travel Post', ['travel', 'europe']);
  writePost(root, 'post-food', 'Food Post', ['food', 'europe']);
  writePost(root, 'post-tech', 'Tech Post', ['technology']);
  writePost(root, 'post-untagged', 'Untagged Post');

  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  runReindex(root);
  t.after(() => db.close());

  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(() => app.close());
  return { root, db, app };
}

test('GET /: tag rail present when there are tags', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /rkr-tag-rail/);
  assert.match(res.body, /travel/);
  assert.match(res.body, /food/);
  assert.match(res.body, /technology/);
  assert.match(res.body, /europe/);
});

test('GET /?tag=travel: only tagged posts returned', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/?tag=travel' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Travel Post/);
  assert.doesNotMatch(res.body, /Food Post/);
  assert.doesNotMatch(res.body, /Tech Post/);
  assert.doesNotMatch(res.body, /Untagged Post/);
});

test('GET /?tag=europe: posts with europe tag returned', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/?tag=europe' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Travel Post/);
  assert.match(res.body, /Food Post/);
  assert.doesNotMatch(res.body, /Tech Post/);
});

test('GET /?tag=travel: active tag marked with aria-current', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/?tag=travel' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /aria-current="page"/);
});

test('GET /?tag=unknown: empty result, tag rail still shown', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/?tag=unknown' });
  assert.equal(res.statusCode, 200);
  // No posts listed
  assert.doesNotMatch(res.body, /Travel Post|Food Post|Tech Post/);
  // Tag rail with real tags still present
  assert.match(res.body, /rkr-tag-rail/);
});

test('GET /?tag=TRAVEL: case-insensitive match', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/?tag=TRAVEL' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Travel Post/);
});

test('GET /?sort=asc: oldest post appears before newest', async (t) => {
  const root = freshSiteRoot(t);
  // Write posts with explicit dates, using a field separator safe for YAML
  const write = (slug: string, title: string, date: string) => {
    const md = `---\ntitle: ${title}\nslug: ${slug}\ndate: ${date}\nstatus: published\n---\n\nBody.\n`;
    fs.writeFileSync(path.join(root, 'content', 'posts', `${slug}.md`), md, 'utf8');
  };
  write('old-post', 'Old Post', '2020-01-01T00:00:00Z');
  write('new-post', 'New Post', '2025-01-01T00:00:00Z');
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  runReindex(root);
  t.after(() => db.close());
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(() => app.close());

  const asc = await app.inject({ method: 'GET', url: '/?sort=asc' });
  const ascOldIdx = asc.body.indexOf('Old Post');
  const ascNewIdx = asc.body.indexOf('New Post');
  assert.ok(ascOldIdx < ascNewIdx, 'oldest first in asc view');

  const desc = await app.inject({ method: 'GET', url: '/' });
  const descOldIdx = desc.body.indexOf('Old Post');
  const descNewIdx = desc.body.indexOf('New Post');
  assert.ok(descNewIdx < descOldIdx, 'newest first in default (desc) view');
});

test('GET /?sort=asc: sort toggle link present', async (t) => {
  const { app } = await setup(t);
  const asc = await app.inject({ method: 'GET', url: '/?sort=asc' });
  assert.match(asc.body, /href="\/"/); // link back to newest-first (no sort param)

  const desc = await app.inject({ method: 'GET', url: '/' });
  assert.match(desc.body, /href="\/\?sort=asc"/); // link to oldest-first
});

// --- Draft vs published visibility -------------------------------------------

test('GET /?tag=travel&tag=food: OR/replace — only first tag is used', async (t) => {
  const root = freshSiteRoot(t);
  writePost(root, 'both', 'Both Tags', ['travel', 'food']);
  writePost(root, 'travel-only', 'Travel Only', ['travel']);
  writePost(root, 'food-only', 'Food Only', ['food']);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  runReindex(root);
  t.after(() => db.close());
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(() => app.close());

  // Multiple ?tag= params: only the first ('travel') is applied.
  const res = await app.inject({ method: 'GET', url: '/?tag=travel&tag=food' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Both Tags/);
  assert.match(res.body, /Travel Only/);
  assert.doesNotMatch(res.body, /Food Only/);
  // Only 'travel' pill is active
  assert.match(res.body, /aria-current="page"/);
});

// --- Draft vs published visibility -------------------------------------------

test('GET /: anonymous view shows no tag pills when all tagged posts are drafts', async (t) => {
  // The rail itself always renders now (it hosts the sort/search
  // controls); only the tag pills are gated on published tagged posts.
  // This is the most common reason tags "don't appear" after saving a
  // post with tags: the post is still a draft, which the index hides.
  const root = freshSiteRoot(t);
  writePostMd(root, 'draft-post', 'Draft Post', 'draft', ['travel']);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  runReindex(root);
  t.after(() => db.close());
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  // Rail (controls) is present, but no tag pills for draft-only posts.
  assert.match(res.body, /rkr-tag-rail/);
  assert.doesNotMatch(
    res.body,
    /rkr-tag-pills/,
    'no tag pills for draft-only posts on anonymous view'
  );
});

test('GET /: anonymous view shows tag pills once a tagged draft is published', async (t) => {
  const root = freshSiteRoot(t);
  writePostMd(root, 'my-post', 'My Post', 'draft', ['travel']);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  runReindex(root);
  t.after(() => db.close());
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(() => app.close());

  const draft = await app.inject({ method: 'GET', url: '/' });
  assert.doesNotMatch(draft.body, /rkr-tag-pills/, 'no tag pills before publishing');

  // Publish the post and re-index.
  writePostMd(root, 'my-post', 'My Post', 'published', ['travel']);
  runReindex(root);

  const published = await app.inject({ method: 'GET', url: '/' });
  assert.match(published.body, /rkr-tag-pills/, 'tag pills appear after publishing');
  assert.match(published.body, /travel/);
});
