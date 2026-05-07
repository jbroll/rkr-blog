import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { read as sidecarRead } from '../../src/lib/sidecar.ts';
import { buildApp } from '../../src/server.ts';

interface ImportResponse {
  id: string;
  bytes: number;
  deduplicated: boolean;
  ext: string;
}

interface ErrorResponse {
  error: string;
}

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-import-url-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function makeJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 100, height: 80, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function startFixtureServer(t: TestContext, handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${addr.port}`;
}

async function setup(t: TestContext) {
  const root = freshSiteRoot(t);
  // Tests bind fixture servers to 127.0.0.1:randomPort, which the
  // production SSRF guard correctly rejects. Inject a plain-fetch
  // passthrough so the URL-import route still exercises its plumbing
  // (content-type/size/stream checks) without the SSRF check firing.
  // SSRF defenses are validated in test/lib/url-safety.test.ts.
  const app = await buildApp({
    siteRoot: root,
    urlFetcher: async (url, opts) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30_000);
      try {
        return await fetch(url, { signal: ac.signal, redirect: 'follow' });
      } finally {
        clearTimeout(timer);
      }
    }
  });
  t.after(() => app.close());
  return { root, app };
}

test('POST /admin/import/url fetches an image and writes original + sidecar', async (t) => {
  const { root, app } = await setup(t);
  const jpeg = await makeJpeg();
  const base = await startFixtureServer(t, (_req, res) => {
    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': String(jpeg.length)
    });
    res.end(jpeg);
  });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/url',
    payload: { url: `${base}/photo.jpg` }
  });
  assert.equal(res.statusCode, 200, res.body);

  const body = res.json<ImportResponse>();
  assert.equal(body.bytes, jpeg.length);
  assert.equal(body.ext, 'jpg');

  const sidecar = await sidecarRead(root, body.id);
  assert.ok(sidecar);
  assert.equal(sidecar?.source.kind, 'url');
  assert.equal(sidecar?.source.originalName, 'photo.jpg');

  const onDisk = fs.readFileSync(
    path.join(root, 'originals', body.id.slice(0, 2), body.id.slice(2, 4), `${body.id}.jpg`)
  );
  assert.deepEqual(onDisk, jpeg);
});

test('POST /admin/import/url 400s on a non-http URL', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/url',
    payload: { url: 'file:///etc/passwd' }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorResponse>().error, /http\(s\) URL/);
});

test('POST /admin/import/url 400s on private/loopback URL via the default SSRF guard', async (t) => {
  // No urlFetcher override → production safeFetch runs and rejects loopback.
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/url',
    payload: { url: 'http://169.254.169.254/latest/meta-data/' }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorResponse>().error, /unsafe url/);
});

test('POST /admin/import/url 400s on missing url field', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'POST', url: '/admin/import/url', payload: {} });
  assert.equal(res.statusCode, 400);
});

test('POST /admin/import/url 400s on a non-2xx upstream response', async (t) => {
  const { app } = await setup(t);
  const base = await startFixtureServer(t, (_req, res) => {
    res.writeHead(404);
    res.end('not found');
  });
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/url',
    payload: { url: `${base}/missing.jpg` }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json<ErrorResponse>().error, /404/);
});

test('POST /admin/import/url 415s when content-type is not image/*', async (t) => {
  const { app } = await setup(t);
  const base = await startFixtureServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('not an image');
  });
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/url',
    payload: { url: `${base}/x.txt` }
  });
  assert.equal(res.statusCode, 415);
  assert.match(res.json<ErrorResponse>().error, /content-type/);
});

test('POST /admin/import/url 413s when content-length exceeds the cap', async (t) => {
  const { app } = await setup(t);
  const base = await startFixtureServer(t, (_req, res) => {
    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': String(100 * 1024 * 1024) // 100 MiB > 50 MiB cap
    });
    // We don't actually need to send the body; the route checks content-length
    // before draining the stream.
    res.end();
  });
  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/url',
    payload: { url: `${base}/huge.jpg` }
  });
  assert.equal(res.statusCode, 413);
  assert.match(res.json<ErrorResponse>().error, /exceeds limit/);
});

test('POST /admin/import/url 413s mid-stream when no content-length is sent', async (t) => {
  const { app } = await setup(t);
  // No content-length header → route can't pre-check size and must rely on
  // the streaming limiter. Send 51 MiB so the limiter trips just past 50 MiB.
  const big = Buffer.alloc(51 * 1024 * 1024, 0xff);
  const base = await startFixtureServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(big);
  });

  const res = await app.inject({
    method: 'POST',
    url: '/admin/import/url',
    payload: { url: `${base}/big.jpg` }
  });
  assert.equal(res.statusCode, 413);
  assert.match(res.json<ErrorResponse>().error, /exceeded limit/);
});

test('POST /admin/import/url derives an originalName from the URL path', async (t) => {
  const { root, app } = await setup(t);
  // Use distinct bytes per request so dedupe doesn't make both requests
  // resolve to the same sidecar (which would always show the first call's name).
  const jpegA = await sharp({
    create: { width: 90, height: 80, channels: 3, background: { r: 10, g: 20, b: 30 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  const jpegB = await sharp({
    create: { width: 100, height: 80, channels: 3, background: { r: 200, g: 100, b: 50 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  const responses = [jpegA, jpegB];
  const base = await startFixtureServer(t, (_req, res) => {
    const body = responses.shift() as Buffer;
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(body.length) });
    res.end(body);
  });

  const res1 = await app.inject({
    method: 'POST',
    url: '/admin/import/url',
    payload: { url: `${base}/path/to/cat.jpg` }
  });
  assert.equal(res1.statusCode, 200);
  const sidecar1 = await sidecarRead(root, res1.json<ImportResponse>().id);
  assert.equal(sidecar1?.source.originalName, 'cat.jpg');

  // Path with no filename → falls back to import.<subtype>
  const res2 = await app.inject({
    method: 'POST',
    url: '/admin/import/url',
    payload: { url: `${base}/no/extension/here` }
  });
  assert.equal(res2.statusCode, 200);
  const sidecar2 = await sidecarRead(root, res2.json<ImportResponse>().id);
  assert.equal(sidecar2?.source.originalName, 'import.jpeg');
});
