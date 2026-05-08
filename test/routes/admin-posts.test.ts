import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { buildApp } from '../../src/server.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-admin-posts-'));
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
  // Pass db so public routes (incl. GET /:slug) register; startWorker:false
  // because we don't render anything in this test.
  const db = open(path.join(root, 'data', 'site.db'));
  t.after(() => db.close());
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(() => app.close());
  return { root, app };
}

const SAMPLE_MD = 'Hello **world**\n\n::image{#abc123def4567890 alt="cap"}\n';

test('POST /admin/posts saves a new post and reindexes (visible at /:slug)', async (t) => {
  const { root, app } = await setup(t);

  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'hello',
      title: 'Hello world',
      status: 'published',
      date: '2026-05-06T14:00:00Z',
      markdown: SAMPLE_MD
    }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<{ slug: string; inserted: boolean }>();
  assert.equal(body.slug, 'hello');
  assert.equal(body.inserted, true);

  // The .md file landed on disk with the right frontmatter and body.
  const onDisk = fs.readFileSync(path.join(root, 'content', 'posts', 'hello.md'), 'utf8');
  assert.match(onDisk, /^---\ntitle: Hello world\nslug: hello\n/);
  assert.match(onDisk, /Hello \*\*world\*\*/);
  assert.match(onDisk, /::image\{#abc123def4567890 alt="cap"\}/);

  // Reindexed → /hello returns 200 (uses the public route from Step 5).
  const page = await app.inject({ method: 'GET', url: '/hello' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<title>Hello world — [^<]+<\/title>/);
});

test('POST /admin/posts accepts a body that opens with a horizontal rule', async (t) => {
  // Regression: proseToMarkdown emits `* * *` (not `---`) for a leading
  // horizontal rule precisely so the editor's own valid output isn't
  // rejected by the frontmatter-smuggling guard. The guard still has
  // to recognise that `* * *` is not a delimiter.
  const { app } = await setup(t);

  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'starts-with-rule',
      title: 'Rule first',
      status: 'draft',
      markdown: '* * *\n\nafter the rule\n'
    }
  });
  assert.equal(res.statusCode, 200, res.body);
});

test('POST /admin/posts overwrites an existing post (inserted=false)', async (t) => {
  const { app } = await setup(t);

  const payload = {
    slug: 'twice',
    title: 'First take',
    status: 'draft',
    markdown: 'v1\n'
  };
  const r1 = await app.inject({ method: 'POST', url: '/admin/posts', payload });
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.json<{ inserted: boolean }>().inserted, true);

  const r2 = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { ...payload, title: 'Second take' }
  });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json<{ inserted: boolean }>().inserted, false);
});

test('POST /admin/posts rejects bad slug / missing title / missing markdown', async (t) => {
  const { app } = await setup(t);

  const bad1 = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { slug: 'has spaces', title: 'X', status: 'draft', markdown: '' }
  });
  assert.equal(bad1.statusCode, 400);
  assert.match(bad1.json<{ error: string }>().error, /slug/);

  const bad2 = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { slug: 'ok', title: '', status: 'draft', markdown: '' }
  });
  assert.equal(bad2.statusCode, 400);
  assert.match(bad2.json<{ error: string }>().error, /title/);

  const bad3 = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { slug: 'ok', title: 'X', status: 'draft', markdown: 42 }
  });
  assert.equal(bad3.statusCode, 400);
  assert.match(bad3.json<{ error: string }>().error, /markdown/);

  // Reject markdown that opens with a YAML frontmatter delimiter — it
  // would smuggle a second frontmatter block past the one we control.
  const bad4 = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'ok',
      title: 'X',
      status: 'draft',
      markdown: '---\ntitle: hijack\n---\n\nbody\n'
    }
  });
  assert.equal(bad4.statusCode, 400);
  assert.match(bad4.json<{ error: string }>().error, /frontmatter/);

  // CR-only line endings must also be caught — a sloppy `\s\n` regex
  // would have let `---\rkey: x\r---` slip through.
  const badCr = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'ok',
      title: 'X',
      status: 'draft',
      markdown: '---\rtitle: hijack\r---\r\nbody\n'
    }
  });
  assert.equal(badCr.statusCode, 400);
  assert.match(badCr.json<{ error: string }>().error, /frontmatter/);

  // `---` followed by prose (no key:value, no closing `---`) is NOT
  // frontmatter — the looksLikeFrontmatterDelimiter heuristic returns
  // false for the first non-empty line that's neither `---` nor a yaml
  // mapping. Accept the body as a normal post.
  const proseAfterDashes = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'prose-dashes',
      title: 'Prose with dashes',
      status: 'draft',
      markdown: '---\nplain prose line that is not yaml\nmore prose\n'
    }
  });
  assert.equal(proseAfterDashes.statusCode, 200, proseAfterDashes.body);

  // `---` with only whitespace lines after also isn't frontmatter (the
  // for-loop completes without ever finding a delimiter or mapping).
  const proseEmptyAfter = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'prose-empty',
      title: 'Empty after dashes',
      status: 'draft',
      markdown: '---\n   \n\n   \n'
    }
  });
  assert.equal(proseEmptyAfter.statusCode, 200, proseEmptyAfter.body);

  // Slug length cap: 200-char slug is rejected even though every char is
  // a valid kebab-case character. Without this, a 50KB slug would be
  // accepted, written to disk as a filename, and indexed.
  const longSlug = 'a'.repeat(200);
  const bad5 = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { slug: longSlug, title: 'X', status: 'draft', markdown: '' }
  });
  assert.equal(bad5.statusCode, 400);
  assert.match(bad5.json<{ error: string }>().error, /slug/);
});
