import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/server.js';

test('GET /health returns 200 {"ok":true}', async () => {
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  } finally {
    await app.close();
  }
});
