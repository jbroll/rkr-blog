import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerCsrfGuard } from '../../src/lib/csrf.ts';

async function makeApp(allowedOrigins: string[]): Promise<FastifyInstance> {
  const app = Fastify();
  registerCsrfGuard(app, { allowedOrigins });
  app.get('/safe', async () => ({ ok: true }));
  app.post('/state-change', async () => ({ ok: true }));
  app.put('/state-change', async () => ({ ok: true }));
  app.delete('/state-change', async () => ({ ok: true }));
  return app;
}

test('csrf: GET passes without Origin', async () => {
  const app = await makeApp(['https://example.com']);
  const res = await app.inject({ method: 'GET', url: '/safe' });
  assert.equal(res.statusCode, 200);
});

test('csrf: POST with matching Origin passes', async () => {
  const app = await makeApp(['https://example.com']);
  const res = await app.inject({
    method: 'POST',
    url: '/state-change',
    headers: { origin: 'https://example.com' }
  });
  assert.equal(res.statusCode, 200);
});

test('csrf: POST with mismatched Origin is rejected', async () => {
  const app = await makeApp(['https://example.com']);
  const res = await app.inject({
    method: 'POST',
    url: '/state-change',
    headers: { origin: 'https://attacker.example' }
  });
  assert.equal(res.statusCode, 403);
});

test('csrf: POST with missing Origin and Referer is rejected', async () => {
  const app = await makeApp(['https://example.com']);
  const res = await app.inject({ method: 'POST', url: '/state-change' });
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /missing Origin/);
});

test('csrf: POST falls back to Referer when Origin is absent', async () => {
  const app = await makeApp(['https://example.com']);
  const res = await app.inject({
    method: 'POST',
    url: '/state-change',
    headers: { referer: 'https://example.com/some/path' }
  });
  assert.equal(res.statusCode, 200);
});

test('csrf: POST with origin "null" (file:// or data:) is rejected', async () => {
  const app = await makeApp(['https://example.com']);
  const res = await app.inject({
    method: 'POST',
    url: '/state-change',
    headers: { origin: 'null' }
  });
  assert.equal(res.statusCode, 403);
});

test('csrf: PUT and DELETE are also gated', async () => {
  const app = await makeApp(['https://example.com']);
  const put = await app.inject({ method: 'PUT', url: '/state-change' });
  assert.equal(put.statusCode, 403);
  const del = await app.inject({ method: 'DELETE', url: '/state-change' });
  assert.equal(del.statusCode, 403);
});

test('csrf: registering with empty origins throws', () => {
  assert.throws(() => registerCsrfGuard(Fastify(), { allowedOrigins: [] }), /at least one/);
});

test('csrf: origin normalization (default port stripped)', async () => {
  const app = await makeApp(['https://example.com:443']); // default https port
  const res = await app.inject({
    method: 'POST',
    url: '/state-change',
    headers: { origin: 'https://example.com' }
  });
  assert.equal(res.statusCode, 200);
});

async function makeSplitApp(): Promise<FastifyInstance> {
  const app = Fastify();
  registerCsrfGuard(app, {
    allowedOrigins: ['https://admin.test'],
    publicOnlyOrigins: ['https://read.test']
  });
  app.post('/:slug/comments', async () => ({ ok: true }));
  app.post('/admin/reset', async () => ({ ok: true }));
  app.post('/admin', async () => ({ ok: true }));
  return app;
}

async function post(app: FastifyInstance, url: string, origin: string): Promise<number> {
  const res = await app.inject({ method: 'POST', url, headers: { origin } });
  return res.statusCode;
}

test('csrf: a public-only origin may post outside /admin', async () => {
  const app = await makeSplitApp();
  assert.equal(await post(app, '/hello/comments', 'https://read.test'), 200);
});

test('csrf: a public-only origin is blocked under /admin', async () => {
  const app = await makeSplitApp();
  assert.equal(await post(app, '/admin/reset', 'https://read.test'), 403);
  assert.equal(await post(app, '/admin', 'https://read.test'), 403);
});

test('csrf: the admin origin reaches both surfaces', async () => {
  const app = await makeSplitApp();
  assert.equal(await post(app, '/admin/reset', 'https://admin.test'), 200);
  assert.equal(await post(app, '/hello/comments', 'https://admin.test'), 200);
});

test('csrf: an unrelated origin is blocked on both surfaces', async () => {
  const app = await makeSplitApp();
  assert.equal(await post(app, '/hello/comments', 'https://attacker.example'), 403);
  assert.equal(await post(app, '/admin/reset', 'https://attacker.example'), 403);
});

test('csrf: /admin detection survives a query string, case, and doubled slashes', async () => {
  const app = await makeSplitApp();
  for (const url of ['/admin/reset?x=1', '/Admin/reset', '//admin/reset', '/admin/reset#frag']) {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { origin: 'https://read.test' }
    });
    assert.equal(res.statusCode, 403, `expected 403 for ${url}, got ${res.statusCode}`);
  }
});

test('csrf: a path merely starting with the letters "admin" is not the admin surface', async () => {
  const app = Fastify();
  registerCsrfGuard(app, {
    allowedOrigins: ['https://admin.test'],
    publicOnlyOrigins: ['https://read.test']
  });
  app.post('/administrivia/comments', async () => ({ ok: true }));
  assert.equal(await post(app, '/administrivia/comments', 'https://read.test'), 200);
});

test('csrf: publicOnly origin can POST /search but 403 on /admin/posts (encoded and case variants)', async () => {
  const app = Fastify();
  registerCsrfGuard(app, {
    allowedOrigins: ['https://admin.test'],
    publicOnlyOrigins: ['https://read.test']
  });
  app.post('/search', async () => ({ ok: true }));
  app.post('/admin/posts', async () => ({ ok: true }));
  app.post('/admin/settings', async () => ({ ok: true }));
  // publicOnly allowed on /search
  assert.equal(await post(app, '/search', 'https://read.test'), 200);
  // blocked on /admin
  assert.equal(await post(app, '/admin/posts', 'https://read.test'), 403);
  // case, double-slash and percent-encoded variants must also be blocked
  assert.equal(await post(app, '/Admin//settings', 'https://read.test'), 403);
  assert.equal(await post(app, '/admin%2Fsettings', 'https://read.test'), 403);
  assert.equal(await post(app, '/ADMIN/settings', 'https://read.test'), 403);
});
