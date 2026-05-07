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
