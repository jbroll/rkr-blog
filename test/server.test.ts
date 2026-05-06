import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { open } from '../src/lib/db.ts';
import { migrate } from '../src/lib/migrate.ts';
import { buildApp, startServer } from '../src/server.ts';

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

test('startServer listens on an ephemeral port and serves /health', async (_t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-startserver-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  // startServer opens the db and starts the worker; both need migrations.
  const seedDb = open(path.join(root, 'data', 'site.db'));
  migrate(seedDb);
  seedDb.close();

  const prevSiteRoot = process.env.SITE_ROOT;
  process.env.SITE_ROOT = root;

  // Silence the "listening on http://..." console.log produced by startServer
  // so it doesn't pollute the TAP stream during the test.
  const originalLog = console.log;
  console.log = () => {};

  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    app = await startServer({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('no server address');

    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    console.log = originalLog;
    if (app) await app.close();
    if (prevSiteRoot === undefined) delete process.env.SITE_ROOT;
    else process.env.SITE_ROOT = prevSiteRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
