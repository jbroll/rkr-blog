import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

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
  assert.equal(body.ext, 'jpg');

  // Original on disk matches input bytes.
  const onDisk = fs.readFileSync(
    path.join(
      root,
      'originals',
      expectedId.slice(0, 2),
      expectedId.slice(2, 4),
      `${expectedId}.jpg`
    )
  );
  assert.deepEqual(onDisk, bytes);

  // Sidecar present with kind=upload.
  const sidecar = await sidecarRead(root, expectedId);
  assert.ok(sidecar);
  assert.equal(sidecar.source.kind, 'upload');
  assert.equal(sidecar.source.originalName, 'photo.jpg');
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

test('GET /admin/posts lists drafts + published; POST /:slug/delete removes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-route-'));
  for (const sub of ['sidecars', 'originals', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Two posts on disk + a db that the route can read.
  fs.writeFileSync(
    path.join(root, 'content', 'posts', 'hello.md'),
    '---\ntitle: Hello\nslug: hello\nstatus: published\ndate: 2026-05-01T00:00:00Z\n---\n\nbody\n'
  );
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

  // runReindex runs on first POST; trigger it via a noop GET to /admin/posts.
  // Actually the listing route reads the index directly; force a reindex by
  // calling runReindex synchronously via require — simpler: hit /admin/posts
  // which queries an empty index until we reindex. Call runReindex directly.
  const { runReindex } = await import('../../src/cli/reindex.ts');
  runReindex(root);

  const list = await app.inject({ method: 'GET', url: '/admin/posts' });
  assert.equal(list.statusCode, 200);
  assert.match(list.body, /Hello/);
  assert.match(list.body, /WIP/);
  assert.match(list.body, /is-draft/);
  assert.match(list.body, /is-published/);
  // edit links + delete forms are rendered for each row
  assert.match(list.body, /\/admin\/editor\?slug=hello/);
  assert.match(list.body, /action="\/admin\/posts\/wip\/delete"/);

  // Delete one post → 303 back to the listing, file gone.
  const del = await app.inject({ method: 'POST', url: '/admin/posts/wip/delete' });
  assert.equal(del.statusCode, 303);
  assert.equal(del.headers.location, '/admin/posts');
  assert.equal(fs.existsSync(path.join(root, 'content', 'posts', 'wip.md')), false);

  // Bad slug → 400; unknown slug → 404.
  const bad = await app.inject({ method: 'POST', url: '/admin/posts/has..dots/delete' });
  assert.equal(bad.statusCode, 400);
  const missing = await app.inject({ method: 'POST', url: '/admin/posts/ghost/delete' });
  assert.equal(missing.statusCode, 404);
});

test('GET /admin/posts empty state when no posts', async (t) => {
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
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /No posts yet/);
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
