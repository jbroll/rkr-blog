import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { runReindex } from '../../src/cli/reindex.ts';
import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { ingestStream } from '../../src/lib/originals.ts';
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
  assert.match(res.body, /<h1>Hello world<button[^>]*class="rkr-post-copylink"/);
  assert.match(res.body, /<strong>bold<\/strong>/);
  assert.match(res.body, /<a href="https:\/\/example.com">link<\/a>/);
  assert.match(res.body, /<h2>A heading<\/h2>/);
});

test('GET /:slug 404s for a draft post with the themed not-found page', async (t) => {
  const { root, app } = await setup(t);
  writePost(root, 'd.md', { slug: 'd', title: 'D', status: 'draft' }, 'body');
  runReindex(root);

  const res = await app.inject({ method: 'GET', url: '/d' });
  assert.equal(res.statusCode, 404);
  // Themed not-found page: site chrome + themed body + back link.
  assert.match(res.headers['content-type'] as string, /text\/html/);
  assert.match(res.body, /<main[^>]*class="rkr-notfound"/);
  assert.match(res.body, /Page not found/);
  assert.match(res.body, /href="\/"/);
  // Stylesheet links pull the active theme so the page actually matches.
  assert.match(res.body, /\/static\/base\.css/);
});

test('GET /:slug 404s for an unknown slug with the themed not-found page', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/no-such-post' });
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /<main[^>]*class="rkr-notfound"/);
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

// Auth-gated branch of the GET / handler: when the request carries
// a bearer token matching ADMIN_TOKEN, the response includes drafts
// (alongside published) in the admin-table render, AND sets
// Cache-Control: private, no-store so the SW + intermediaries don't
// shadow the session-private body into the next anonymous load.
//
// Bearer auth requires auth-middleware to be registered, which the
// default setup() skips (public routes don't need it). Build a
// one-off app with the auth opt threaded through so req.user can
// actually be set from the Authorization header.
test('GET / authed: includes drafts + admin table + no-store header', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-public-authed-'));
  for (const sub of ['sidecars', 'originals', 'content/posts', 'data', 'cache/img']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());

  const prevToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'test-public-admin-token';
  t.after(() => {
    if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prevToken;
  });

  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: {
      // Bearer-token path doesn't exchange OAuth codes, but the auth
      // opt object is required to register the middleware that
      // reads the Authorization header.
      exchange: {
        authorizationUrl: () => new URL('https://example.com/'),
        exchange: async () => {
          throw new Error('not used');
        }
      },
      secureCookies: false,
      skipGate: true
    }
  });
  t.after(async () => {
    await app.close();
    events.removeAllListeners('enqueued');
  });

  writePost(root, 'pub.md', { slug: 'pub', title: 'Pub', status: 'published' }, 'b');
  writePost(root, 'draft.md', { slug: 'draft', title: 'Drafty', status: 'draft' }, 'b');
  runReindex(root);

  const res = await app.inject({
    method: 'GET',
    url: '/',
    headers: { authorization: 'Bearer test-public-admin-token' }
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Drafty/);
  assert.match(res.body, /Pub/);
  // Admin-table markers from the renderIndexPage admin branch
  // (no <thead> — controls' aria-labels carry their accessible names).
  assert.match(res.body, /<table class="rkr-admin-posts">/);
  assert.match(res.body, /action="\/admin\/posts\/draft\/status"/);
  assert.match(res.body, /<script[^>]*src="\/static\/admin\/posts-list\.js"/);
  // SW honours no-store on the response and skips caching so a
  // post-action redirect doesn't shadow the next load.
  assert.match(res.headers['cache-control'] as string, /no-store/);

  // The admin table links drafts straight to /:slug; the detail
  // route must honor auth and render the draft rather than 404.
  const draftRes = await app.inject({
    method: 'GET',
    url: '/draft',
    headers: { authorization: 'Bearer test-public-admin-token' }
  });
  assert.equal(draftRes.statusCode, 200);
  assert.match(draftRes.body, /Drafty/);
  assert.match(draftRes.headers['cache-control'] as string, /no-store/);
});

// Anonymous GET / must NOT carry no-store; SWR caching is the
// offline-browse path for logged-out visitors.
test('GET / anonymous: no Cache-Control no-store header', async (t) => {
  const { root, app } = await setup(t);
  writePost(root, 'pub.md', { slug: 'pub', title: 'Pub', status: 'published' }, 'b');
  runReindex(root);
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  const cc = (res.headers['cache-control'] as string | undefined) ?? '';
  assert.ok(!/no-store/i.test(cc), `unexpected no-store: ${cc}`);
});

// ---- banner rendering -------------------------------------------------

async function makeJpegBuf(seed = 0) {
  return sharp({
    create: {
      width: 640 + seed,
      height: 480,
      channels: 3,
      background: { r: 30 + seed, g: 60, b: 120 }
    }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function ingestOne(root: string): Promise<string> {
  const r = await ingestStream({
    stream: Readable.from([await makeJpegBuf()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'banner.jpg' }
  });
  return r.id;
}

test('GET /:slug: first ::figure is extracted as banner, rendered before <main> with bleed, absent from body', async (t) => {
  const { root, app } = await setup(t);
  const id = await ingestOne(root);
  writePost(
    root,
    'banner.md',
    {
      slug: 'banner-post',
      title: 'Banner Post',
      status: 'published',
      date: '2026-05-14T12:00:00Z'
    },
    `::figure{ids="${id}"}\n\nSome body text.`
  );
  runReindex(root);

  const res = await app.inject({ method: 'GET', url: '/banner-post' });
  assert.equal(res.statusCode, 200);

  // Banner with bleed class must appear before <main>.
  const mainIdx = res.body.indexOf('<main');
  const bleedIdx = res.body.indexOf('rkr-justify-bleed');
  assert.ok(bleedIdx > 0, 'banner rendered');
  assert.ok(bleedIdx < mainIdx, 'banner appears before <main>');

  // The article body must not contain the figure (it was promoted to banner).
  const articleStart = res.body.indexOf('<article>');
  const articleEnd = res.body.indexOf('</article>');
  assert.ok(articleStart > 0 && articleEnd > articleStart, 'article present');
  const articleHtml = res.body.slice(articleStart, articleEnd);
  assert.doesNotMatch(articleHtml, /rkr-figure/, 'figure not in article body');

  // The body text that follows the figure must still render.
  assert.match(articleHtml, /Some body text/);
});

test('GET /:slug: banner: frontmatter fallback renders bleed banner when body has no leading figure', async (t) => {
  const { root, app } = await setup(t);
  const id = await ingestOne(root);
  writePost(
    root,
    'fm-banner.md',
    {
      slug: 'fm-banner',
      title: 'FM Banner',
      status: 'published',
      date: '2026-05-14T12:00:00Z',
      banner: id
    },
    'Body text with no leading figure.'
  );
  runReindex(root);

  const res = await app.inject({ method: 'GET', url: '/fm-banner' });
  assert.equal(res.statusCode, 200);

  // Frontmatter banner rendered with bleed before <main>.
  const mainIdx = res.body.indexOf('<main');
  const bleedIdx = res.body.indexOf('rkr-justify-bleed');
  assert.ok(bleedIdx > 0, 'banner rendered from frontmatter');
  assert.ok(bleedIdx < mainIdx, 'banner before <main>');

  // Body text still present in article.
  assert.match(res.body, /Body text with no leading figure/);
});

test('GET /:slug: ::figure NOT first (text before it) stays in body, no banner', async (t) => {
  const { root, app } = await setup(t);
  const id = await ingestOne(root);
  writePost(
    root,
    'inline.md',
    {
      slug: 'inline-post',
      title: 'Inline Post',
      status: 'published',
      date: '2026-05-14T12:00:00Z'
    },
    `Intro paragraph.\n\n::figure{ids="${id}"}`
  );
  runReindex(root);

  const res = await app.inject({ method: 'GET', url: '/inline-post' });
  assert.equal(res.statusCode, 200);

  // No bleed banner before <main>.
  const mainIdx = res.body.indexOf('<main');
  const beforeMain = res.body.slice(0, mainIdx);
  assert.doesNotMatch(beforeMain, /rkr-justify-bleed/);

  // Figure is inside the article.
  const articleStart = res.body.indexOf('<article>');
  const articleEnd = res.body.indexOf('</article>');
  const articleHtml = res.body.slice(articleStart, articleEnd);
  assert.match(articleHtml, /rkr-figure/);
});

test('GET / with site bannerImageId: banner rendered before <main> with bleed', async (t) => {
  // Set up manually so we can pass site: { bannerImageId } to buildApp
  // without opening a second DB connection on the same file.
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const id = await ingestOne(root);

  const appWithBanner = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    site: { title: 'Test Site', bannerImageId: id }
  });
  t.after(async () => {
    await appWithBanner.close();
    events.removeAllListeners('enqueued');
  });

  writePost(
    root,
    'post.md',
    { slug: 'p', title: 'P', status: 'published', date: '2026-05-14T12:00:00Z' },
    'body'
  );
  runReindex(root);

  const res = await appWithBanner.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);

  const mainIdx = res.body.indexOf('<main');
  const bleedIdx = res.body.indexOf('rkr-justify-bleed');
  assert.ok(bleedIdx > 0, 'banner rendered on index');
  assert.ok(bleedIdx < mainIdx, 'banner appears before <main>');
});
