import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { _resetThemeNameCache } from '../../src/lib/config.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { read as sidecarRead } from '../../src/lib/sidecar.ts';
import { buildApp } from '../../src/server.ts';
import { buildMultipart } from '../helpers/multipart.ts';
import type { ErrorBody } from '../helpers/oauth-fixtures.ts';

interface UploadResponseBody {
  id: string;
  bytes: number;
  deduplicated: boolean;
  ext: string;
}

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-route-'));
  fs.mkdirSync(path.join(root, 'sidecars'), { recursive: true });
  fs.mkdirSync(path.join(root, 'originals'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function makeJpeg() {
  return sharp({
    create: { width: 80, height: 60, channels: 3, background: { r: 100, g: 50, b: 25 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

test('POST /admin/upload writes original + sidecar', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const bytes = await makeJpeg();
  const expectedId = crypto.createHash('sha256').update(bytes).digest('hex');

  const { payload, headers } = buildMultipart({
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    bytes
  });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/upload',
    payload,
    headers
  });

  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<UploadResponseBody>();
  assert.equal(body.id, expectedId);
  assert.equal(body.bytes, bytes.length);
  assert.equal(body.deduplicated, false);
  // Ingest re-encodes every raster master to WebP (see ingest-resize.ts).
  assert.equal(body.ext, 'webp');

  // Original on disk exists at the new ext (bytes differ from input
  // because they're the post-resize WebP — verify presence + non-empty).
  const onDiskPath = path.join(
    root,
    'originals',
    expectedId.slice(0, 2),
    expectedId.slice(2, 4),
    `${expectedId}.webp`
  );
  assert.ok(fs.existsSync(onDiskPath));
  assert.ok(fs.statSync(onDiskPath).size > 0);

  // Sidecar present with kind=upload. Upload provenance preserved.
  const sidecar = await sidecarRead(root, expectedId);
  assert.ok(sidecar);
  assert.equal(sidecar.source.kind, 'upload');
  assert.equal(sidecar.source.originalName, 'photo.jpg');
  assert.equal(sidecar.source.uploadFormat, 'jpeg');
});

test('POST /admin/upload dedupes a byte-identical re-upload', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const bytes = await makeJpeg();

  for (let i = 0; i < 2; i++) {
    const { payload, headers } = buildMultipart({
      filename: `try-${i}.jpg`,
      contentType: 'image/jpeg',
      bytes
    });
    const res = await app.inject({ method: 'POST', url: '/admin/upload', payload, headers });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json<UploadResponseBody>();
    assert.equal(body.deduplicated, i === 1);
  }
});

test('POST /admin/upload rejects non-image payloads', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const { payload, headers } = buildMultipart({
    filename: 'hello.txt',
    contentType: 'text/plain',
    bytes: Buffer.from('not an image')
  });

  const res = await app.inject({ method: 'POST', url: '/admin/upload', payload, headers });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorBody>().error, /not a recognized image/);
});

test('GET /admin/posts → 301 redirect to /; POST /:slug/delete still works', async (t) => {
  // The standalone admin posts page is gone — the homepage doubles
  // as the admin posts list when authed (see public.ts: drafts +
  // status / pin / delete render when req.user is set). The legacy
  // URL 301s so bookmarks and any pre-removal admin-strip clicks
  // still land in the right place. The POST /:slug/delete endpoint
  // is unchanged — the new homepage's per-row delete form points at
  // it directly.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-route-'));
  for (const sub of ['sidecars', 'originals', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'content', 'posts', 'wip.md'),
    '---\ntitle: WIP\nslug: wip\nstatus: draft\ndate: 2026-05-02T00:00:00Z\n---\n\nbody\n'
  );
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  const app = await buildApp({ siteRoot: root, db });
  t.after(async () => {
    await app.close();
    db.close();
  });
  const { runReindex } = await import('../../src/lib/post-index.ts');
  runReindex(root);

  const redirect = await app.inject({ method: 'GET', url: '/admin/posts' });
  assert.equal(redirect.statusCode, 301);
  assert.equal(redirect.headers.location, '/');

  // Delete still removes the markdown file + returns 303.
  const del = await app.inject({ method: 'POST', url: '/admin/posts/wip/delete' });
  assert.equal(del.statusCode, 303);
  assert.equal(del.headers.location, '/');
  assert.equal(fs.existsSync(path.join(root, 'content', 'posts', 'wip.md')), false);

  // Bad slug → 400; unknown slug → 404.
  const bad = await app.inject({ method: 'POST', url: '/admin/posts/has..dots/delete' });
  assert.equal(bad.statusCode, 400);
  const missing = await app.inject({ method: 'POST', url: '/admin/posts/ghost/delete' });
  assert.equal(missing.statusCode, 404);
});

// One smoke test per theme: each must render the homepage under its
// SITE_THEME, with the three-layer stylesheet chain (base + default +
// active) in the expected cascade order. This catches a missing CSS
// file, a typo in the theme name list, or a regression in the layout
// helper. (Previously this checked /admin/posts; that page is now a
// 301 to / and the cascade matters most on the public-facing index.)
for (const theme of ['papermod', 'tufte', 'dracula', 'terminal', 'solarized', 'mvp', 'newsprint']) {
  test(`GET / honors SITE_THEME=${theme} (smoke)`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-route-'));
    for (const sub of ['sidecars', 'originals', 'content/posts', 'data']) {
      fs.mkdirSync(path.join(root, sub), { recursive: true });
    }
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const prev = process.env.SITE_THEME;
    process.env.SITE_THEME = theme;
    _resetThemeNameCache();
    t.after(() => {
      if (prev !== undefined) process.env.SITE_THEME = prev;
      else delete process.env.SITE_THEME;
      _resetThemeNameCache();
    });

    const db = open(path.join(root, 'data', 'site.db'));
    migrate(db);
    const app = await buildApp({ siteRoot: root, db });
    t.after(async () => {
      await app.close();
      db.close();
    });

    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /\/static\/base\.css/);
    assert.match(res.body, /\/static\/themes\/default\.css/);
    assert.match(res.body, new RegExp(`/static/themes/${theme}\\.css`));
    // Cascade order: default precedes active so the active wins.
    const defaultIdx = res.body.indexOf('/static/themes/default.css');
    const activeIdx = res.body.indexOf(`/static/themes/${theme}.css`);
    assert.ok(defaultIdx < activeIdx, `default must come before ${theme} in cascade`);
  });
}

test('GET /admin/posts empty state still 301-redirects', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-route-'));
  for (const sub of ['sidecars', 'originals', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  const app = await buildApp({ siteRoot: root, db });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const res = await app.inject({ method: 'GET', url: '/admin/posts' });
  assert.equal(res.statusCode, 301);
  assert.equal(res.headers.location, '/');
});

test('POST /admin/upload returns 400 when no file part is present', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // Field-only multipart, no file.
  const boundary = '----rkrtest';
  const payload = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\nhi\r\n--${boundary}--\r\n`
  );
  const res = await app.inject({
    method: 'POST',
    url: '/admin/upload',
    payload,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(payload.length)
    }
  });
  // @fastify/multipart treats this as no file; we return 400.
  assert.equal(res.statusCode, 400);
});

test('POST /admin/posts: empty slug + title → server slugifies title; subtitle round-trips', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-route-'));
  for (const sub of ['sidecars', 'originals', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  const app = await buildApp({ siteRoot: root, db });
  t.after(async () => {
    await app.close();
    db.close();
  });

  // No slug in the payload — the server should slugify the title.
  // Subtitle is passed; we expect to see it in the rendered post page.
  const post = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: '',
      title: 'Hello World!',
      subtitle: 'a friendly subtitle',
      status: 'published',
      markdown: 'body\n'
    }
  });
  assert.equal(post.statusCode, 200, post.body);
  const body = post.json<{ slug: string }>();
  assert.equal(body.slug, 'hello-world', 'server slugified the title');

  // Subtitle landed in the frontmatter and renders on the post page.
  const page = await app.inject({ method: 'GET', url: '/hello-world' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<p class="rkr-post-subtitle">a friendly subtitle</);

  // The on-disk markdown carries the subtitle key (verifies the
  // serialiser wrote it; future parsers will pick it up).
  const md = fs.readFileSync(path.join(root, 'content', 'posts', 'hello-world.md'), 'utf8');
  assert.match(md, /^subtitle: a friendly subtitle$/m);
});

test('POST /admin/posts: bare slug still rejected; subtitle is optional', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-route-'));
  for (const sub of ['sidecars', 'originals', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  const app = await buildApp({ siteRoot: root, db });
  t.after(async () => {
    await app.close();
    db.close();
  });

  // Explicit bad slug → 400. Length cap + kebab-case regex still apply.
  const bad = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { slug: 'has..dots', title: 'T', markdown: 'b\n' }
  });
  assert.equal(bad.statusCode, 400);

  // No subtitle → frontmatter omits the field (not a stray empty line).
  const ok = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { slug: '', title: 'no-sub', status: 'published', markdown: 'body\n' }
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const md = fs.readFileSync(path.join(root, 'content', 'posts', 'no-sub.md'), 'utf8');
  assert.equal(md.includes('subtitle:'), false);
});
