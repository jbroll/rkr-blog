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

/** Write a minimal published post with optional tags. */
function writePost(root: string, slug: string, title: string, tags: string[] = []): void {
  const tagsBlock = tags.length > 0 ? `tags:\n${tags.map((t) => `- ${t}`).join('\n')}\n` : '';
  const md = `---\ntitle: ${title}\nslug: ${slug}\ndate: 2026-01-01T00:00:00Z\nstatus: published\n${tagsBlock}---\n\nBody text.\n`;
  fs.writeFileSync(path.join(root, 'content', 'posts', `${slug}.md`), md, 'utf8');
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
