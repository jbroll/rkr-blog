import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { runReindex } from '../../src/cli/reindex.ts';
import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { buildApp } from '../../src/server.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-pages-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'content/posts', 'data']) {
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

async function setup(t: TestContext) {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());

  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(async () => {
    await app.close();
    events.removeAllListeners('enqueued');
  });

  return { root, db, app };
}

test('GET / returns an HTML index of published posts', async (t) => {
  const { root, app } = await setup(t);

  writePost(
    root,
    'a.md',
    { slug: 'a', title: 'Alpha', status: 'published', date: '2026-05-06T14:00:00Z' },
    'body a'
  );
  writePost(
    root,
    'b.md',
    { slug: 'b', title: 'Bravo', status: 'published', date: '2026-05-07T14:00:00Z' },
    'body b'
  );
  writePost(root, 'd.md', { slug: 'd', title: 'Drafty', status: 'draft' }, 'body d');
  runReindex(root);

  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  // Most recent first.
  const idxAlpha = res.body.indexOf('Alpha');
  const idxBravo = res.body.indexOf('Bravo');
  assert.ok(idxBravo > 0 && idxAlpha > 0 && idxBravo < idxAlpha, 'newest first');
  // Drafts not listed.
  assert.equal(res.body.includes('Drafty'), false);
});

test('GET /:slug includes the lightbox script tag', async (t) => {
  const { root, app } = await setup(t);
  writePost(
    root,
    'lb.md',
    { slug: 'lb', title: 'Lightbox', status: 'published', date: '2026-05-06T14:00:00Z' },
    'body'
  );
  runReindex(root);
  const res = await app.inject({ method: 'GET', url: '/lb' });
  assert.equal(res.statusCode, 200);
  // Versioned URL: bundleVersion() suffixes ?v=<gitHash> per-deploy
  // for SW cache invalidation (templates/layout.ts). Unversioned in
  // dev only when no git hash resolves; both shapes accepted.
  assert.match(
    res.body,
    /<script type="module" src="\/static\/site\/lightbox\.js(\?v=[0-9a-f]+)?" defer>/
  );
  assert.match(
    res.body,
    /<script type="module" src="\/static\/site\/img-retry\.js(\?v=[0-9a-f]+)?" defer>/
  );
});

test('GET / does NOT include the lightbox script (no figures on index)', async (t) => {
  const { root, app } = await setup(t);
  writePost(
    root,
    'a.md',
    { slug: 'a', title: 'A', status: 'published', date: '2026-05-06T14:00:00Z' },
    'body'
  );
  runReindex(root);
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.includes('lightbox.js'), false);
});

test('GET /:slug renders the post body to HTML', async (t) => {
  const { root, app } = await setup(t);

  writePost(
    root,
    'hello.md',
    { slug: 'hello', title: 'Hello world', status: 'published', date: '2026-05-06T14:00:00Z' },
    `Para with **bold** and a [link](https://example.com).\n\n## A heading\n\nMore prose.`
  );
  runReindex(root);

  const res = await app.inject({ method: 'GET', url: '/hello' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  assert.match(res.body, /<title>Hello world — [^<]+<\/title>/);
  assert.match(res.body, /<h1>Hello world<\/h1>/);
  assert.match(res.body, /<strong>bold<\/strong>/);
  assert.match(res.body, /<a href="https:\/\/example.com">link<\/a>/);
  assert.match(res.body, /<h2>A heading<\/h2>/);
});

test('GET /:slug 404s for a draft post', async (t) => {
  const { root, app } = await setup(t);
  writePost(root, 'd.md', { slug: 'd', title: 'D', status: 'draft' }, 'body');
  runReindex(root);

  const res = await app.inject({ method: 'GET', url: '/d' });
  assert.equal(res.statusCode, 404);
});

test('GET /:slug 404s for an unknown slug', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/no-such-post' });
  assert.equal(res.statusCode, 404);
});

test('GET / paginates when published posts exceed the page size', async (t) => {
  const { root, app } = await setup(t);

  // Page size is 20 in src/routes/public.ts; create 25 posts.
  for (let i = 0; i < 25; i++) {
    const padded = String(i).padStart(2, '0');
    writePost(
      root,
      `${padded}.md`,
      {
        slug: `p${padded}`,
        title: `Post ${padded}`,
        status: 'published',
        date: `2026-05-${(i % 28) + 1 < 10 ? '0' : ''}${(i % 28) + 1}T00:00:00Z`
      },
      'body'
    );
  }
  runReindex(root);

  const r1 = await app.inject({ method: 'GET', url: '/' });
  assert.equal(r1.statusCode, 200);
  assert.match(r1.body, /page 1 of 2/);
  assert.match(r1.body, /rel="next"/);

  const r2 = await app.inject({ method: 'GET', url: '/?page=2' });
  assert.equal(r2.statusCode, 200);
  assert.match(r2.body, /page 2 of 2/);
  assert.match(r2.body, /rel="prev"/);
});

test('GET / and GET /:slug emit CSP + X-Content-Type-Options + frame-blocking headers', async (t) => {
  // Defense-in-depth for the markdown renderer's "raw HTML passes
  // through" trust decision: a misclick or pasted HTML can't open
  // arbitrary script-src or be framed for clickjacking.
  const { root, app } = await setup(t);
  writePost(
    root,
    'a.md',
    { slug: 'a', title: 'Alpha', status: 'published', date: '2026-05-06T14:00:00Z' },
    'body a'
  );
  runReindex(root);

  for (const url of ['/', '/a']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, `${url} → ${res.statusCode}`);
    const csp = res.headers['content-security-policy'] as string;
    assert.match(csp, /default-src 'self'/, `${url}: csp default-src`);
    assert.match(csp, /frame-ancestors 'none'/, `${url}: csp frame-ancestors`);
    assert.match(csp, /script-src 'self'/, `${url}: csp script-src`);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', `${url}: nosniff`);
    assert.equal(res.headers['x-frame-options'], 'DENY', `${url}: x-frame-options`);
    assert.match(
      res.headers['referrer-policy'] as string,
      /strict-origin-when-cross-origin/,
      `${url}: referrer-policy`
    );
  }
});
