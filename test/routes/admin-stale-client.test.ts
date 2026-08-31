// Stale-client guard on the drain routes. A client launched offline
// boots the cached shell and its cached bundle; if the server was
// redeployed before connectivity returned, the drain fires from that
// old bundle with no navigation in between to refresh it. Each drain
// route refuses a write stamped with a build that isn't the running
// one.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';

import { _resetGitHashCache } from '../../src/lib/build-info.ts';
import { staleClientRejection } from '../../src/lib/client-build.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { ingestStream } from '../../src/lib/originals.ts';
import { buildApp } from '../../src/server.ts';
import { buildMultipart, buildMultipartParts } from '../helpers/multipart.ts';

const BUILD = 'deadbeefcafe';
const OLD_BUILD = '0123456789ab';

/** Pin the server's build so the guard has a known value to compare
 * against — outside a git checkout resolveGitHash returns 'unknown'
 * and the guard deliberately disables itself. */
function pinBuild(t: TestContext, hash = BUILD): void {
  const prior = process.env.GIT_HASH;
  process.env.GIT_HASH = hash;
  _resetGitHashCache();
  t.after(() => {
    if (prior === undefined) delete process.env.GIT_HASH;
    else process.env.GIT_HASH = prior;
    _resetGitHashCache();
  });
}

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-stale-client-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function setup(t: TestContext) {
  pinBuild(t);
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  t.after(() => db.close());
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(() => app.close());
  return { root, app, db };
}

function makeJpeg(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#456' } })
    .jpeg()
    .toBuffer();
}

function savePost(app: FastifyInstance, slug: string, headers: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers,
    payload: { title: 'Stale', slug, markdown: 'body' }
  });
}

// ---- the pure guard ----------------------------------------------

test('staleClientRejection: no header is permissive', () => {
  assert.equal(staleClientRejection(undefined), null);
  assert.equal(staleClientRejection(''), null);
  assert.equal(staleClientRejection(42), null);
});

test('staleClientRejection: a matching build passes', (t) => {
  pinBuild(t);
  assert.equal(staleClientRejection(BUILD), null);
});

test('staleClientRejection: a mismatched build is refused', (t) => {
  pinBuild(t);
  assert.deepEqual(staleClientRejection(OLD_BUILD), {
    error: 'stale-client',
    serverBuild: BUILD
  });
});

test('staleClientRejection: a server that cannot resolve its own hash stays permissive', () => {
  // Refusing every write because the server is outside a git checkout
  // would be worse than the drift the guard exists to catch.
  assert.equal(staleClientRejection(OLD_BUILD, 'unknown'), null);
});

// ---- POST /admin/posts -------------------------------------------

test('POST /admin/posts: a stale build is refused with 426', async (t) => {
  const { root, app } = await setup(t);
  const res = await savePost(app, 'stale-post', { 'x-rkr-build': OLD_BUILD });
  assert.equal(res.statusCode, 426);
  assert.equal(res.json().error, 'stale-client');
  assert.equal(res.json().serverBuild, BUILD);
  assert.equal(
    fs.existsSync(path.join(root, 'content', 'posts', 'stale-post.md')),
    false,
    'the refused write must not have landed'
  );
});

test('POST /admin/posts: the current build and a missing header both write', async (t) => {
  const { root, app } = await setup(t);
  assert.equal((await savePost(app, 'current', { 'x-rkr-build': BUILD })).statusCode, 200);
  assert.equal((await savePost(app, 'headerless', {})).statusCode, 200);
  assert.ok(fs.existsSync(path.join(root, 'content', 'posts', 'current.md')));
  assert.ok(fs.existsSync(path.join(root, 'content', 'posts', 'headerless.md')));
});

test('POST /admin/posts: a lost-ACK replay from a stale build still gets its stored 2xx', async (t) => {
  const { app } = await setup(t);
  const key = { 'x-rkr-device-id': 'dev-S', 'x-rkr-outbox-seq': '7' };
  const first = await savePost(app, 'replayed', { ...key, 'x-rkr-build': BUILD });
  assert.equal(first.statusCode, 200);

  // The write already landed; the ACK was lost and the client has
  // since gone stale. Re-running the guard here would turn a
  // succeeded write into a permanent failure.
  const replay = await savePost(app, 'replayed', { ...key, 'x-rkr-build': OLD_BUILD });
  assert.equal(replay.statusCode, 200, 'replay must short-circuit before the staleness check');
  assert.deepEqual(replay.json(), first.json());
});

// ---- POST /admin/upload ------------------------------------------

test('POST /admin/upload: a stale build is refused with 426', async (t) => {
  const { root, app } = await setup(t);
  const mp = buildMultipart({
    filename: 'x.jpg',
    contentType: 'image/jpeg',
    bytes: await makeJpeg(64, 48)
  });
  const res = await app.inject({
    method: 'POST',
    url: '/admin/upload',
    headers: { ...mp.headers, 'x-rkr-build': OLD_BUILD },
    payload: mp.payload
  });
  assert.equal(res.statusCode, 426);
  assert.equal(res.json().error, 'stale-client');
  assert.deepEqual(fs.readdirSync(path.join(root, 'sidecars')), [], 'nothing was ingested');
});

test('POST /admin/upload: the current build writes', async (t) => {
  const { root, app } = await setup(t);
  const mp = buildMultipart({
    filename: 'x.jpg',
    contentType: 'image/jpeg',
    bytes: await makeJpeg(64, 48)
  });
  const res = await app.inject({
    method: 'POST',
    url: '/admin/upload',
    headers: { ...mp.headers, 'x-rkr-build': BUILD },
    payload: mp.payload
  });
  assert.equal(res.statusCode, 200);
  assert.equal(fs.readdirSync(path.join(root, 'sidecars')).length, 1);
});

// ---- POST /admin/sidecar/:id/commit ------------------------------

test('POST /admin/sidecar/:id/commit: a stale build is refused with 426', async (t) => {
  const { root, app } = await setup(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpeg(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'x.jpg' }
  });
  const mp = buildMultipartParts([
    { kind: 'field', fieldName: 'ops', value: JSON.stringify({ ops: [], redoStack: [] }) }
  ]);
  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/commit`,
    headers: { ...mp.headers, 'x-rkr-build': OLD_BUILD },
    payload: mp.payload
  });
  assert.equal(res.statusCode, 426);
  assert.equal(res.json().error, 'stale-client');
});

test('POST /admin/sidecar/:id/commit: the current build writes', async (t) => {
  const { root, app } = await setup(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpeg(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'x.jpg' }
  });
  const mp = buildMultipartParts([
    { kind: 'field', fieldName: 'ops', value: JSON.stringify({ ops: [], redoStack: [] }) }
  ]);
  const res = await app.inject({
    method: 'POST',
    url: `/admin/sidecar/${ingest.id}/commit`,
    headers: { ...mp.headers, 'x-rkr-build': BUILD },
    payload: mp.payload
  });
  assert.equal(res.statusCode, 200);
});
