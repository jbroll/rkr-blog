import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { runReindex } from '../../src/lib/post-index.ts';
import { buildApp } from '../../src/server.ts';

async function setup(t: TestContext, site: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-home-'));
  for (const sub of ['content/posts', 'content/blocks', 'data', 'macros']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    site: { title: 'Home Site', ...site }
  });
  t.after(async () => {
    await app.close();
    events.removeAllListeners('enqueued');
  });
  const page = (slug: string, text: string, fields: Record<string, unknown> = {}) => {
    fs.writeFileSync(
      path.join(root, 'content', 'blocks', `${slug}.json`),
      JSON.stringify({
        version: 1,
        body: [{ type: 'text', markdown: text }],
        fields: { title: `Title ${slug}`, slug, status: 'published', ...fields }
      })
    );
    runReindex(root);
  };
  return { root, app, page };
}

test('homePage set to a published page: / renders it for anonymous', async (t) => {
  const { app, page } = await setup(t, { homePage: 'welcome' });
  page('welcome', 'Welcome text.', { kind: 'page' });
  page('p1', 'Post.', { title: 'A Post' });
  const anon = await app.inject({ method: 'GET', url: '/' });
  assert.equal(anon.statusCode, 200);
  assert.match(anon.body, /Welcome text\./);
  assert.doesNotMatch(anon.body, /A Post/);
  assert.doesNotMatch(anon.body, /<h1/);
});

test('/posts always serves the post index', async (t) => {
  const { app, page } = await setup(t, { homePage: 'welcome' });
  page('welcome', 'Welcome text.', { kind: 'page' });
  page('p1', 'Post.', { title: 'A Post' });
  const res = await app.inject({ method: 'GET', url: '/posts' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /A Post/);
  assert.doesNotMatch(res.body, /Welcome text\./);
});

test('homePage unset, missing, a draft, or kind post: / is the index', async (t) => {
  const unset = await setup(t);
  unset.page('p1', 'Post.', { title: 'A Post' });
  assert.match((await unset.app.inject({ method: 'GET', url: '/' })).body, /A Post/);

  const missing = await setup(t, { homePage: 'nope' });
  missing.page('p1', 'Post.', { title: 'A Post' });
  assert.match((await missing.app.inject({ method: 'GET', url: '/' })).body, /A Post/);

  const draft = await setup(t, { homePage: 'welcome' });
  draft.page('welcome', 'Welcome text.', { kind: 'page', status: 'draft' });
  draft.page('p1', 'Post.', { title: 'A Post' });
  const draftRes = await draft.app.inject({ method: 'GET', url: '/' });
  assert.match(draftRes.body, /A Post/);
  assert.doesNotMatch(draftRes.body, /Welcome text\./);

  const post = await setup(t, { homePage: 'welcome' });
  post.page('welcome', 'Welcome text.', { title: 'Welcome Post' });
  const postRes = await post.app.inject({ method: 'GET', url: '/' });
  assert.match(postRes.body, /rkr-index-heading/);
});

test('the home page slug 301s to /; a draft named as homePage does not redirect', async (t) => {
  const { app, page } = await setup(t, { homePage: 'welcome' });
  page('welcome', 'Welcome text.', { kind: 'page' });
  const res = await app.inject({ method: 'GET', url: '/welcome' });
  assert.equal(res.statusCode, 301);
  assert.equal(res.headers.location, '/');

  const d = await setup(t, { homePage: 'soon' });
  d.page('soon', 'Soon.', { kind: 'page', status: 'draft' });
  assert.equal((await d.app.inject({ method: 'GET', url: '/soon' })).statusCode, 404);
});

test('index links use /posts when homePage is set: tag pills, sort toggle, pager', async (t) => {
  const { app, page } = await setup(t, { homePage: 'welcome' });
  page('welcome', 'Welcome text.', { kind: 'page' });
  page('p1', 'Post.', { title: 'A Post', tags: ['x'] });
  const res = await app.inject({ method: 'GET', url: '/posts' });
  const body = res.body;
  assert.match(body, /href="\/posts\?tag=x"/);
  assert.doesNotMatch(body, /href="\/\?tag=/);
  assert.match(body, /href="\/posts\?sort=asc"/);
  assert.match(body, /<a class="rkr-site-head-auth-btn" href="\/">Home<\/a>/);

  const plain = await setup(t);
  plain.page('p1', 'Post.', { title: 'A Post', tags: ['x'] });
  assert.match((await plain.app.inject({ method: 'GET', url: '/' })).body, /href="\/\?tag=x"/);
});

test('GET /about serves the about block page when published, else _about.md', async (t) => {
  const { root, app, page } = await setup(t);
  fs.writeFileSync(
    path.join(root, 'content', 'posts', '_about.md'),
    '---\nslug: _about\ntitle: Old About\nstatus: published\n---\n\nFrom markdown.\n'
  );
  assert.match((await app.inject({ method: 'GET', url: '/about' })).body, /From markdown\./);

  page('about', 'From blocks.', { kind: 'page', title: 'About Us', status: 'draft' });
  assert.match((await app.inject({ method: 'GET', url: '/about' })).body, /From markdown\./);

  page('about', 'From blocks.', { kind: 'page', title: 'About Us' });
  const res = await app.inject({ method: 'GET', url: '/about' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /From blocks\./);
  assert.doesNotMatch(res.body, /From markdown\./);
});

test('GET /about 301s to / when the about page is the home page', async (t) => {
  const { app, page } = await setup(t, { homePage: 'about' });
  page('about', 'From blocks.', { kind: 'page', title: 'About Us' });
  const res = await app.inject({ method: 'GET', url: '/about' });
  assert.equal(res.statusCode, 301);
  assert.equal(res.headers.location, '/');
  assert.ok(res.headers['content-security-policy']);
  assert.match((await app.inject({ method: 'GET', url: '/' })).body, /From blocks\./);
});

test('GET /about is 404 with neither a block page nor _about.md', async (t) => {
  const { app } = await setup(t);
  assert.equal((await app.inject({ method: 'GET', url: '/about' })).statusCode, 404);
});

test('a post with slug posts logs a reindex warning and /posts serves the index', async (t) => {
  const { app, page } = await setup(t);
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    errors.push(a.join(' '));
  };
  try {
    page('posts', 'Body.', { title: 'Posts Post' });
  } finally {
    console.error = orig;
  }
  assert.ok(errors.some((e) => /slug "posts"/.test(e)));
  const res = await app.inject({ method: 'GET', url: '/posts' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /rkr-index-heading/);
  assert.match(res.body, /Posts Post/);
});
