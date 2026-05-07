import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { open } from '../src/lib/db.ts';
import { migrate } from '../src/lib/migrate.ts';
import { buildApp, startServer } from '../src/server.ts';

test('GET /health returns 200 with ok flag and git hash', async () => {
  const app = await buildApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ ok: boolean; gitHash: string; gitHashShort: string }>();
    assert.equal(body.ok, true);
    // Either a real SHA (40 hex) resolved from the local .git, the
    // GIT_HASH_FILE the Docker build writes, or 'unknown' when neither
    // is present. The endpoint must never crash on missing git state.
    assert.ok(
      body.gitHash === 'unknown' || /^[0-9a-f]{7,40}$/.test(body.gitHash),
      `unexpected gitHash: ${body.gitHash}`
    );
    if (body.gitHash === 'unknown') {
      assert.equal(body.gitHashShort, 'unknown');
    } else {
      assert.equal(body.gitHashShort, body.gitHash.slice(0, 12));
    }
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

  const prev = {
    SITE_ROOT: process.env.SITE_ROOT,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL
  };
  process.env.SITE_ROOT = root;
  // startServer wires auth in production; supply env so makeGoogleExchange
  // can build the Google client. We don't actually call any /admin/auth
  // endpoint in this test.
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:8080';

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
    const body = (await res.json()) as { ok: boolean; gitHash: string };
    assert.equal(body.ok, true);
    assert.ok(
      body.gitHash === 'unknown' || /^[0-9a-f]{7,40}$/.test(body.gitHash),
      `unexpected gitHash: ${body.gitHash}`
    );
  } finally {
    console.log = originalLog;
    if (app) await app.close();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
