// pushPost end-to-end: fixture WP server → app under test → assert
// posts table + originals dir on the target.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import type { WpPost } from '../../src/lib/wp-import.ts';
import { pushPost } from '../../src/lib/wp-push.ts';
import type { TokenExchange } from '../../src/routes/auth.ts';
import { buildApp } from '../../src/server.ts';

const noopAuthExchange: TokenExchange = {
  authorizationUrl: () => new URL('https://example.com/'),
  exchange: async () => {
    throw new Error('not used');
  }
};

async function makeJpeg(seed: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 80 + (seed % 11),
      height: 60 + (seed % 7),
      channels: 3,
      background: { r: 30 + seed, g: 60, b: 200 - seed }
    }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-wp-push-target-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * Spin up a fixture WP server. The post template uses `{{HOST}}` as a
 * placeholder for image URLs; the handler substitutes the request's
 * actual Host on every response so the test code doesn't have to know
 * the port in advance.
 */
async function startWpFixture(
  t: TestContext,
  post: WpPost,
  imageBytes: Map<string, Buffer>
): Promise<string> {
  const server = http.createServer((req, res) => {
    const host = req.headers.host ?? '127.0.0.1';
    const url = new URL(req.url ?? '/', `http://${host}`);

    // Real WP returns an array on /wp-json/wp/v2/posts?slug=foo; the
    // fixture matches that form (which is what wp-push.fetchWpPost uses
    // for non-numeric slugs).
    if (url.pathname === `/wp-json/wp/v2/posts/${post.id}`) {
      const rewritten = {
        ...post,
        content: { rendered: post.content.rendered.replaceAll('{{HOST}}', host) }
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rewritten));
      return;
    }
    if (url.pathname === '/wp-json/wp/v2/posts' && url.searchParams.get('slug') === post.slug) {
      const rewritten = {
        ...post,
        content: { rendered: post.content.rendered.replaceAll('{{HOST}}', host) }
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([rewritten]));
      return;
    }
    const buf = imageBytes.get(url.pathname);
    if (buf) {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(buf);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

async function startTargetApp(
  t: TestContext,
  adminToken: string
): Promise<{ baseUrl: string; siteRoot: string }> {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  t.after(() => db.close());

  const prev = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = adminToken;
  t.after(() => {
    if (prev === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prev;
  });

  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    auth: {
      exchange: noopAuthExchange,
      secureCookies: false,
      allowedOrigins: ['http://localhost']
    }
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => app.close());
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { baseUrl: url, siteRoot: root };
}

const TWO_UP: WpPost = {
  id: 42,
  date: '2026-04-30T12:00:00',
  modified: '2026-04-30T12:00:00',
  slug: 'two-up',
  status: 'publish',
  title: { rendered: 'Two Images' },
  content: {
    rendered: `
<p>Opening prose.</p>
<figure class="wp-block-image"><img src="http://{{HOST}}/img1.jpg" alt="one"/><figcaption>first</figcaption></figure>
<figure class="wp-block-image"><img src="http://{{HOST}}/img2.jpg" alt="two"/></figure>
<p>Closing prose.</p>
`
  },
  excerpt: { rendered: '' },
  link: 'http://wp.example/two-up/'
};

// Plain-fetch image fetcher for tests — bypasses safeFetch's loopback /
// non-default-port rejection so the fixture can serve from 127.0.0.1.
async function plainFetchImage(url: string): Promise<Readable> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch ${res.status} ${url}`);
  if (!res.body) throw new Error(`image fetch ${url}: empty body`);
  return Readable.fromWeb(res.body);
}

test('pushPost: WP fixture → target via bearer; markdown + originals land', async (t) => {
  const target = await startTargetApp(t, 'token-abc');
  const images = new Map<string, Buffer>([
    ['/img1.jpg', await makeJpeg(1)],
    ['/img2.jpg', await makeJpeg(2)]
  ]);
  const wpBaseUrl = await startWpFixture(t, TWO_UP, images);

  const result = await pushPost({
    wpBaseUrl,
    slug: 'two-up',
    toUrl: target.baseUrl,
    token: 'token-abc',
    fetchImage: plainFetchImage
  });

  assert.equal(result.slug, 'two-up');
  assert.equal(result.inserted, true);
  assert.equal(result.imagesUploaded, 2);
  assert.equal(result.imagesFailed, 0);
  assert.equal(result.status, 'published');

  // Markdown landed on the target.
  const md = fs.readFileSync(path.join(target.siteRoot, 'content', 'posts', 'two-up.md'), 'utf8');
  assert.match(md, /title: Two Images/);
  assert.match(md, /status: published/);
  assert.match(md, /Opening prose\./);
  // Two top-level figures (not a nested gallery) → two separate
  // ::figure directives, each with its own sha256 id, alt, and (for
  // the first) caption from the figcaption.
  assert.match(md, /::figure\{ids="[0-9a-f]{64}" alts="one" caption="first"\}/);
  assert.match(md, /::figure\{ids="[0-9a-f]{64}" alts="two"\}/);

  // Walk the sharded originals tree on the target — should find 2
  // image files (originals/<id[0:2]>/<id[2:4]>/<id>.<ext>).
  const targetOriginals = fs
    .readdirSync(path.join(target.siteRoot, 'originals'), { recursive: true })
    .filter((f) => /\.(jpg|jpeg|png|webp|avif)$/i.test(String(f)));
  assert.equal(targetOriginals.length, 2);

  // Public route serves the post.
  const publicRes = await fetch(`${target.baseUrl}/two-up`);
  assert.equal(publicRes.status, 200);
  const html = await publicRes.text();
  assert.match(html, /<title>Two Images/);
});

test('pushPost: wrong bearer token → /admin/posts 401, throws', async (t) => {
  const target = await startTargetApp(t, 'right-token');
  const wpBaseUrl = await startWpFixture(
    t,
    {
      ...TWO_UP,
      slug: 'auth-fail',
      content: { rendered: '<p>just text</p>' }
    },
    new Map()
  );

  await assert.rejects(
    () =>
      pushPost({
        wpBaseUrl,
        slug: 'auth-fail',
        toUrl: target.baseUrl,
        token: 'wrong-token'
      }),
    /401/
  );
});

test('pushPost: --status draft preserves draft on target', async (t) => {
  const target = await startTargetApp(t, 'tok');
  const wpBaseUrl = await startWpFixture(
    t,
    {
      ...TWO_UP,
      slug: 'draft-roundtrip',
      content: { rendered: '<p>draft body</p>' }
    },
    new Map()
  );

  const result = await pushPost({
    wpBaseUrl,
    slug: 'draft-roundtrip',
    toUrl: target.baseUrl,
    token: 'tok',
    status: 'draft'
  });
  assert.equal(result.status, 'draft');

  const md = fs.readFileSync(
    path.join(target.siteRoot, 'content', 'posts', 'draft-roundtrip.md'),
    'utf8'
  );
  assert.match(md, /status: draft/);
});

test('pushPost: trailing slash on target URL is normalised', async (t) => {
  const target = await startTargetApp(t, 'tok');
  const wpBaseUrl = await startWpFixture(
    t,
    {
      ...TWO_UP,
      slug: 'slash-norm',
      content: { rendered: '<p>x</p>' }
    },
    new Map()
  );

  // Pass `<base>/` — pushPost must strip the trailing / so the request
  // goes to /admin/posts and not //admin/posts (some servers 404 on
  // double-slash paths and fastify itself normalises them, so this is
  // really a regression guard for the client-side splice).
  const result = await pushPost({
    wpBaseUrl,
    slug: 'slash-norm',
    toUrl: `${target.baseUrl}/`,
    token: 'tok'
  });
  assert.equal(result.slug, 'slash-norm');
});

test('pushPost: numeric WP id resolves via /wp-json/wp/v2/posts/<id>', async (t) => {
  const target = await startTargetApp(t, 'tok');
  const wpBaseUrl = await startWpFixture(
    t,
    {
      ...TWO_UP,
      id: 42,
      slug: 'numeric-id',
      content: { rendered: '<p>x</p>' }
    },
    new Map()
  );
  // Pass the numeric id; pushPost takes the /posts/<id> branch in
  // fetchWpPost (slug-string branch is exercised by the other tests).
  const result = await pushPost({
    wpBaseUrl,
    slug: 42,
    toUrl: target.baseUrl,
    token: 'tok'
  });
  assert.equal(result.slug, 'numeric-id');
});

test('pushPost: WP returns 500 for /posts/<id> → error includes URL', async (t) => {
  const target = await startTargetApp(t, 'tok');
  const wpServer = http.createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('upstream down');
  });
  await new Promise<void>((r) => wpServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => wpServer.close(() => r())));
  const wpUrl = `http://127.0.0.1:${(wpServer.address() as AddressInfo).port}`;

  await assert.rejects(
    () => pushPost({ wpBaseUrl: wpUrl, slug: 7, toUrl: target.baseUrl, token: 'tok' }),
    /WP fetch: 503/
  );
});

test('pushPost: WP returns 500 on /posts?slug=… → error includes URL', async (t) => {
  const target = await startTargetApp(t, 'tok');
  const wpServer = http.createServer((_req, res) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('bad gateway');
  });
  await new Promise<void>((r) => wpServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => wpServer.close(() => r())));
  const wpUrl = `http://127.0.0.1:${(wpServer.address() as AddressInfo).port}`;

  await assert.rejects(
    () => pushPost({ wpBaseUrl: wpUrl, slug: 'no-such', toUrl: target.baseUrl, token: 'tok' }),
    /WP fetch: 502/
  );
});

test('pushPost: WP returns empty array for slug → throws "no post"', async (t) => {
  const target = await startTargetApp(t, 'tok');
  const wpServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[]');
  });
  await new Promise<void>((r) => wpServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => wpServer.close(() => r())));
  const wpUrl = `http://127.0.0.1:${(wpServer.address() as AddressInfo).port}`;

  await assert.rejects(
    () => pushPost({ wpBaseUrl: wpUrl, slug: 'missing', toUrl: target.baseUrl, token: 'tok' }),
    /no post with slug "missing"/
  );
});

test('pushPost: per-image upload failure increments imagesFailed and continues', async (t) => {
  const target = await startTargetApp(t, 'tok');
  const wpBaseUrl = await startWpFixture(
    t,
    {
      ...TWO_UP,
      slug: 'partial-upload-fail',
      content: { rendered: TWO_UP.content.rendered.replaceAll('{{HOST}}', '{{HOST}}') }
    },
    new Map([
      ['/img1.jpg', await makeJpeg(11)],
      ['/img2.jpg', await makeJpeg(12)]
    ])
  );

  // Wrap fetch so the FIRST /admin/upload call returns 500, subsequent
  // /admin/upload calls succeed, /admin/posts succeeds normally. Hits
  // both the catch block (counted failure, warned to console) and the
  // uploadOriginal !res.ok branch.
  let uploadCalls = 0;
  const flakyFetcher: typeof fetch = async (...args) => {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] as URL).toString();
    if (url.endsWith('/admin/upload')) {
      uploadCalls++;
      if (uploadCalls === 1) {
        return new Response('upstream wedged', { status: 500 });
      }
    }
    return fetch(args[0] as Parameters<typeof fetch>[0], args[1]);
  };

  const result = await pushPost({
    wpBaseUrl,
    slug: 'partial-upload-fail',
    toUrl: target.baseUrl,
    token: 'tok',
    fetcher: flakyFetcher,
    fetchImage: plainFetchImage
  });
  assert.equal(result.imagesFailed, 1, 'one image upload was rejected');
  assert.equal(result.imagesUploaded, 1, 'second image still landed');
  assert.equal(result.slug, 'partial-upload-fail');
});
