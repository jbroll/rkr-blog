import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { ingestStream } from '../../src/lib/originals.ts';
import {
  type DerivativeArgs,
  derivativeFilename,
  derivativePath,
  type Output,
  type Variant
} from '../../src/lib/render.ts';
import { buildApp } from '../../src/server.ts';
import type { ErrorBody } from '../helpers/oauth-fixtures.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-public-'));
  for (const sub of ['sidecars', 'originals', 'cache/img']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function makeJpeg() {
  return sharp({
    create: { width: 200, height: 150, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function setup(t: TestContext) {
  const root = freshSiteRoot(t);
  const db = open(':memory:');
  migrate(db);
  t.after(() => db.close());

  const ingestResult = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });

  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(async () => {
    await app.close();
    events.removeAllListeners('enqueued');
  });

  return { root, db, app, sidecar: ingestResult.sidecar };
}

test('GET /img/<id>.<ophash>.<fmt> on cache miss renders and serves bytes', async (t) => {
  const { root, app, sidecar } = await setup(t);

  // Pick a real (variant, output) declared in the sidecar.
  const variant = sidecar.variants[0] as Variant;
  const output = sidecar.outputs[0] as Output;
  const args: DerivativeArgs = {
    originalId: sidecar.original,
    ops: sidecar.ops as DerivativeArgs['ops'],
    variant,
    output
  };
  const filename = derivativeFilename(args);
  const expectedPath = derivativePath(root, args);

  // Cache file does not exist before the request.
  assert.equal(fs.existsSync(expectedPath), false, 'cache miss precondition');

  const res = await app.inject({ method: 'GET', url: `/img/${filename}` });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['content-type'], `image/${output.format}`);

  // The cache file is now on disk and its bytes match the response.
  assert.ok(fs.existsSync(expectedPath), 'cache file should be written');
  const onDisk = fs.readFileSync(expectedPath);
  assert.deepEqual(res.rawPayload, onDisk);
});

test('GET /img/<filename> on cache hit serves the cached bytes', async (t) => {
  const { root, app, sidecar } = await setup(t);

  const variant = sidecar.variants[1] as Variant;
  const output = sidecar.outputs[0] as Output;
  const args: DerivativeArgs = {
    originalId: sidecar.original,
    ops: sidecar.ops as DerivativeArgs['ops'],
    variant,
    output
  };
  const filename = derivativeFilename(args);
  const expectedPath = derivativePath(root, args);

  // First request: warms the cache.
  const r1 = await app.inject({ method: 'GET', url: `/img/${filename}` });
  assert.equal(r1.statusCode, 200);
  assert.ok(fs.existsSync(expectedPath));
  const cachedBytes = fs.readFileSync(expectedPath);

  // Touch mtime to detect re-renders.
  const fixedTime = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(expectedPath, fixedTime, fixedTime);
  const mtimeBefore = fs.statSync(expectedPath).mtimeMs;

  // Second request: must be served from cache (no rewrite of the file).
  const r2 = await app.inject({ method: 'GET', url: `/img/${filename}` });
  assert.equal(r2.statusCode, 200);
  assert.deepEqual(r2.rawPayload, cachedBytes);
  assert.equal(
    fs.statSync(expectedPath).mtimeMs,
    mtimeBefore,
    'cache hit must not rewrite the file (Sharp must not be invoked)'
  );
});

test('GET /img/<filename> 404s on a malformed filename', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/img/not-a-derivative-name.png' });
  assert.equal(res.statusCode, 404);
  assert.match(res.json<ErrorBody>().error, /bad filename/);
});

test('GET /img/<filename> 404s when no sidecar matches the originalId', async (t) => {
  const { app } = await setup(t);
  const fakeId = crypto.randomBytes(32).toString('hex');
  const fakeOphash = 'a'.repeat(12);
  const res = await app.inject({
    method: 'GET',
    url: `/img/${fakeId}.${fakeOphash}.webp`
  });
  assert.equal(res.statusCode, 404);
  assert.match(res.json<ErrorBody>().error, /unknown original/);
});

test('GET /img/<filename> 404s when the ophash does not match any variant×output', async (t) => {
  const { app, sidecar } = await setup(t);
  const wrongOphash = 'f'.repeat(12);
  const res = await app.inject({
    method: 'GET',
    url: `/img/${sidecar.original}.${wrongOphash}.webp`
  });
  assert.equal(res.statusCode, 404);
  assert.match(res.json<ErrorBody>().error, /no matching variant/);
});

test('GET /img/<filename> on budget-exceeded enqueues + returns 202', async (t) => {
  const { root, db, sidecar } = await setup(t);

  // Build a separate app with renderBudgetMs=0 so the timer always wins.
  const app = await buildApp({ siteRoot: root, db, renderBudgetMs: 0, startWorker: false });
  t.after(async () => {
    await app.close();
    events.removeAllListeners('enqueued');
  });

  const variant = sidecar.variants[2] as Variant;
  const output = sidecar.outputs[0] as Output;
  const args: DerivativeArgs = {
    originalId: sidecar.original,
    ops: sidecar.ops as DerivativeArgs['ops'],
    variant,
    output
  };
  const filename = derivativeFilename(args);

  const res = await app.inject({ method: 'GET', url: `/img/${filename}` });
  assert.equal(res.statusCode, 202);
  assert.equal(res.json<{ status: string }>().status, 'rendering');

  // The job must be on the queue (queued or already running/done depending
  // on how fast the in-flight render finished after the timeout returned).
  const row = db
    .prepare<{ kind: string; state: string }>('SELECT kind, state FROM jobs WHERE cache_key=?')
    .get(filename.split('.')[1] as string);
  assert.ok(row, 'job should exist for this cacheKey');
  assert.equal(row.kind, 'render');
  assert.match(row.state, /queued|running|done|failed/);
});

test.after(() => {
  events.removeAllListeners('enqueued');
});
