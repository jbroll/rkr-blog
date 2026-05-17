import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { open } from '../../src/lib/db.ts';
import { runReindex } from '../../src/lib/post-index.ts';
import { buildApp } from '../../src/server.ts';

function seed(
  root: string,
  file: string,
  slug: string,
  title: string,
  status: string,
  body: string
): void {
  fs.writeFileSync(
    path.join(root, 'content', 'posts', file),
    `---\nslug: ${slug}\ntitle: ${title}\nstatus: ${status}\ndate: 2026-05-01\n---\n\n${body}\n`
  );
}

async function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-search-'));
  for (const s of ['content/posts', 'data']) {
    fs.mkdirSync(path.join(root, s), { recursive: true });
  }
  seed(root, 'pub.md', 'pub', 'Rust Async', 'published', 'tokio runtime details here');
  seed(root, 'draft.md', 'draft', 'Secret Draft', 'draft', 'tokio draft only');
  runReindex(root);
  const db = open(path.join(root, 'data', 'site.db'));
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, root };
}

test('GET /search with no q renders the prompt state', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/search' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Type a query/);
});

test('anonymous search returns published hits with a <mark> snippet, not drafts', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/search?q=tokio' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<a href="\/pub">Rust Async<\/a>/);
  assert.match(res.body, /<mark>/);
  assert.doesNotMatch(res.body, /Secret Draft/);
});

test('query is HTML-escaped (no XSS via q)', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: `/search?q=${encodeURIComponent('<script>x</script>')}`
  });
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body, /<script>x<\/script>/);
});
