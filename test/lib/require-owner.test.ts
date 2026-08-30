import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

import { requireOwner } from '../../src/lib/auth-middleware.ts';
import type { User } from '../../src/lib/users.ts';

function makeUser(role: 'owner' | 'editor'): User {
  return {
    id: 1,
    email: 'a@x.com',
    display_name: null,
    role,
    created_at: new Date().toISOString(),
    last_seen_at: null
  };
}

test('requireOwner allows owner', async () => {
  const app = Fastify();
  app.get('/owner-only', { preHandler: requireOwner }, async () => ({ ok: true }));
  // inject user via hook
  app.addHook('onRequest', async (req) => {
    (req as unknown as { user: User }).user = makeUser('owner');
  });
  const res = await app.inject({ method: 'GET', url: '/owner-only' });
  assert.equal(res.statusCode, 200);
});

test('requireOwner 403s when role !== owner', async () => {
  const app = Fastify();
  app.get('/owner-only', { preHandler: requireOwner }, async () => ({ ok: true }));
  app.addHook('onRequest', async (req) => {
    (req as unknown as { user: User }).user = makeUser('editor');
  });
  const res = await app.inject({ method: 'GET', url: '/owner-only' });
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /owner role required/);
});

test('requireOwner 401s when no user', async () => {
  const app = Fastify();
  app.get('/owner-only', { preHandler: requireOwner }, async () => ({ ok: true }));
  const res = await app.inject({ method: 'GET', url: '/owner-only' });
  assert.equal(res.statusCode, 401);
});
