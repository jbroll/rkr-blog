// Server-side outbox idempotency (Task 8). A drained POST carries
// (x-rkr-device-id, x-rkr-outbox-seq). A lost-ACK replay must NOT
// produce a phantom 409 that the user could "discard" — dropping a
// newer coalesced edit. Two layers: the applied_outbox table
// (replayed key → stored 2xx) and the cheap byte-identical no-op
// (self-heals even with no table row / no db wired).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { ingestStream } from '../../src/lib/originals.ts';
import { buildApp } from '../../src/server.ts';
import { buildMultipartParts } from '../helpers/multipart.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-outbox-idem-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** App WITH a db wired so the applied_outbox table path is exercised. */
async function setupWithDb(t: TestContext) {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  t.after(() => db.close());
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(() => app.close());
  return { root, app, db };
}

/** App WITHOUT a db (matches the lighter admin test harness) — only
 * the cheap byte-identical layer is available. */
async function setupNoDb(t: TestContext) {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root, startWorker: false });
  t.after(() => app.close());
  return { root, app };
}

function readPost(root: string, slug: string): string {
  return fs.readFileSync(path.join(root, 'content', 'posts', `${slug}.md`), 'utf8');
}

test('table layer: replayed (device,seq) returns the original 2xx, not a 409', async (t) => {
  const { root, app, db } = await setupWithDb(t);

  // First drain: creates the post. Carries device id + seq.
  const first = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: { 'x-rkr-device-id': 'dev-A', 'x-rkr-outbox-seq': '1' },
    payload: { title: 'Idem One', slug: 'idem-one', markdown: 'First body.' }
  });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json();

  // A genuine concurrent edit lands (different content) AFTER the
  // first drain — bumps the file mtime past anything the queued
  // replay believed.
  const concurrent = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { title: 'Idem One', slug: 'idem-one', markdown: 'Newer concurrent body.' }
  });
  assert.equal(concurrent.statusCode, 200);

  // The lost-ACK replay: SAME device+seq, AND a stale
  // X-Rkr-Last-Synced-At baked in. Without idempotency this is the
  // phantom-409 path. With the table it returns the original 2xx.
  const replay = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: {
      'x-rkr-device-id': 'dev-A',
      'x-rkr-outbox-seq': '1',
      'x-rkr-last-synced-at': '2000-01-01T00:00:00.000Z'
    },
    payload: { title: 'Idem One', slug: 'idem-one', markdown: 'First body.' }
  });
  assert.equal(replay.statusCode, 200, 'replay must not 409');
  assert.deepEqual(replay.json(), firstBody, 'replay returns the stored original body');

  // The concurrent edit survived — the replay did NOT overwrite it.
  assert.match(readPost(root, 'idem-one'), /Newer concurrent body\./);

  // The applied_outbox row exists and is keyed correctly.
  const row = db
    .prepare('SELECT status FROM applied_outbox WHERE device_id = ? AND seq = ?')
    .get('dev-A', 1) as { status: number } | undefined;
  assert.equal(row?.status, 200);
});

test('cheap layer: byte-identical replay with NO table row (no db) returns 2xx, not 409', async (t) => {
  const { root, app } = await setupNoDb(t);

  const first = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: { 'x-rkr-device-id': 'dev-B', 'x-rkr-outbox-seq': '5' },
    payload: { title: 'Idem Two', slug: 'idem-two', markdown: 'Stable body.' }
  });
  assert.equal(first.statusCode, 200);

  const before = readPost(root, 'idem-two');

  // Simulate a lost-ACK replay across a client restart: the table
  // row never existed (no db here), and the queued payload carries a
  // stale lastSyncedAt. The bytes are identical to disk → satisfied
  // no-op, NOT a 409.
  const replay = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: {
      'x-rkr-device-id': 'dev-B',
      'x-rkr-outbox-seq': '5',
      'x-rkr-last-synced-at': '2000-01-01T00:00:00.000Z'
    },
    payload: { title: 'Idem Two', slug: 'idem-two', markdown: 'Stable body.' }
  });
  assert.equal(replay.statusCode, 200, 'byte-identical replay must not 409');
  assert.equal(replay.json().slug, 'idem-two');
  // File unchanged (no rewrite churn).
  assert.equal(readPost(root, 'idem-two'), before);
});

test('genuine concurrent divergence still 409s (real conflict detection intact)', async (t) => {
  const { root, app } = await setupNoDb(t);

  const first = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { title: 'Idem Three', slug: 'idem-three', markdown: 'Original.' }
  });
  assert.equal(first.statusCode, 200);
  const syncedAt = first.json().updatedAt as string;

  // A concurrent writer advances the file well past `syncedAt`.
  await new Promise((r) => setTimeout(r, 20));
  const concurrent = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { title: 'Idem Three', slug: 'idem-three', markdown: 'Concurrent change.' }
  });
  assert.equal(concurrent.statusCode, 200);

  // A DIFFERENT-content save with the now-stale baseline must still
  // 409 — the idempotency layers must not neuter real conflict
  // detection. (No device/seq here: a fresh non-replay write.)
  const diverged = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: { 'x-rkr-last-synced-at': syncedAt },
    payload: { title: 'Idem Three', slug: 'idem-three', markdown: 'My divergent edit.' }
  });
  assert.equal(diverged.statusCode, 409, 'divergent content + stale baseline must 409');
  assert.equal(diverged.json().error, 'post-superseded');
  assert.match(readPost(root, 'idem-three'), /Concurrent change\./);
});

async function makeJpeg(w: number, h: number): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 50, g: 90, b: 200 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function makeWebp(w: number, h: number): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 60, g: 100, b: 180 } }
  })
    .webp({ quality: 90 })
    .toBuffer();
}

function commit(
  app: FastifyInstance,
  id: string,
  body: { ops: unknown; redoStack?: unknown },
  headers: Record<string, string>,
  bake?: Buffer
) {
  const parts: Parameters<typeof buildMultipartParts>[0][number][] = [
    { kind: 'field', fieldName: 'ops', value: JSON.stringify(body) }
  ];
  if (bake) {
    parts.push({
      kind: 'file',
      fieldName: 'bake',
      filename: `${id}.webp`,
      contentType: 'image/webp',
      bytes: bake
    });
  }
  const mp = buildMultipartParts(parts);
  return app.inject({
    method: 'POST',
    url: `/admin/sidecar/${id}/commit`,
    headers: { ...mp.headers, ...headers },
    payload: mp.payload
  });
}

test('commitImageEdit: replayed (device,seq) short-circuits to the original 2xx', async (t) => {
  const { root, app, db } = await setupWithDb(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpeg(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'x.jpg' }
  });

  const ops = { ops: [{ type: 'crop', x: 0, y: 0, w: 400, h: 300 }], redoStack: [] };
  const idemHeaders = { 'x-rkr-device-id': 'dev-C', 'x-rkr-outbox-seq': '9' };

  const first = await commit(app, ingest.id, ops, idemHeaders, await makeWebp(400, 300));
  assert.equal(first.statusCode, 200, `body: ${first.body}`);
  const firstBody = first.json();

  // Replay: SAME device+seq, this time WITHOUT a bake (which for a
  // non-empty-ops commit would normally 400 "bake required"). The
  // idempotency short-circuit must return the original 2xx.
  const replay = await commit(app, ingest.id, ops, idemHeaders);
  assert.equal(replay.statusCode, 200, 'replay must short-circuit, not 400');
  assert.deepEqual(replay.json(), firstBody, 'replay returns the stored original body');

  const row = db
    .prepare('SELECT status FROM applied_outbox WHERE device_id = ? AND seq = ?')
    .get('dev-C', 9) as { status: number } | undefined;
  assert.equal(row?.status, 200);
});

function sidecarUpdatedAt(root: string, id: string): string {
  return new Date(fs.statSync(path.join(root, 'sidecars', `${id}.json`)).mtimeMs).toISOString();
}

test('commitImageEdit meta echoes the sidecar updatedAt for the edit-start baseline', async (t) => {
  const { root, app } = await setupNoDb(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpeg(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'x.jpg' }
  });
  const meta = await app.inject({ method: 'GET', url: `/admin/sidecar/${ingest.id}/meta` });
  assert.equal(meta.statusCode, 200);
  const body = meta.json();
  assert.equal(typeof body.updatedAt, 'string', 'meta must expose a sidecar updatedAt');
  assert.equal(body.updatedAt, sidecarUpdatedAt(root, ingest.id));
});

test('commitImageEdit: STALE replay past an advanced sidecar → 409 sidecar-superseded, newer edit preserved', async (t) => {
  // Core data-loss regression. Device goes offline with a queued
  // commitImageEdit (old ops). Its applied_outbox row is pruned
  // (offline > retention). Meanwhile a NEWER edit to the SAME image
  // lands. The stale replay arrives last: it must be REJECTED (409),
  // NOT silently revert the image to the old ops + bake.
  const { root, app, db } = await setupWithDb(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpeg(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'x.jpg' }
  });

  // Edit-start baseline the offline client honestly observed.
  const editStartBase = sidecarUpdatedAt(root, ingest.id);

  const staleOps = { ops: [{ type: 'crop', x: 0, y: 0, w: 400, h: 300 }], redoStack: [] };

  // A NEWER edit to the same image lands while the device is offline.
  await new Promise((r) => setTimeout(r, 20));
  const newerOps = { ops: [{ type: 'crop', x: 10, y: 10, w: 500, h: 400 }], redoStack: [] };
  const newer = await commit(app, ingest.id, newerOps, {}, await makeWebp(500, 400));
  assert.equal(newer.statusCode, 200, `body: ${newer.body}`);
  const newerSidecar = JSON.parse(
    fs.readFileSync(path.join(root, 'sidecars', `${ingest.id}.json`), 'utf8')
  );
  assert.deepEqual(newerSidecar.ops, newerOps.ops, 'newer ops on disk');
  // Read whatever the newer commit wrote so we can prove it survives
  // the stale replay.
  const { bakePath } = await import('../../src/lib/originals.ts');
  const newerBake = fs.readFileSync(bakePath(root, ingest.id));

  // The STALE replay: the offline client's queued entry, replayed
  // after its applied_outbox row was pruned. It carries the
  // edit-start baseline (older than the newer edit's mtime) and
  // DIFFERENT ops → genuine stale clobber → must 409.
  const replay = await commit(
    app,
    ingest.id,
    staleOps,
    {
      'x-rkr-device-id': 'dev-stale',
      'x-rkr-outbox-seq': '42',
      'x-rkr-sidecar-base': editStartBase
    },
    await makeWebp(400, 300)
  );
  assert.equal(
    replay.statusCode,
    409,
    `stale replay must 409, got ${replay.statusCode}: ${replay.body}`
  );
  assert.equal(replay.json().error, 'sidecar-superseded');

  // The newer edit SURVIVED — no silent revert.
  const afterSidecar = JSON.parse(
    fs.readFileSync(path.join(root, 'sidecars', `${ingest.id}.json`), 'utf8')
  );
  assert.deepEqual(afterSidecar.ops, newerOps.ops, 'newer ops must be preserved (no revert)');
  assert.deepEqual(fs.readFileSync(bakePath(root, ingest.id)), newerBake, 'newer bake preserved');

  // No applied_outbox row recorded for the rejected stale replay.
  const row = db
    .prepare('SELECT status FROM applied_outbox WHERE device_id = ? AND seq = ?')
    .get('dev-stale', 42) as { status: number } | undefined;
  assert.equal(row, undefined, 'a rejected 409 must not be recorded as applied');
});

test('commitImageEdit: pure replay with NO table row + identical on-disk ops/bake → 2xx no-op, not 409', async (t) => {
  const { root, app } = await setupNoDb(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpeg(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'x.jpg' }
  });

  const ops = { ops: [{ type: 'crop', x: 0, y: 0, w: 400, h: 300 }], redoStack: [] };
  const first = await commit(app, ingest.id, ops, {}, await makeWebp(400, 300));
  assert.equal(first.statusCode, 200, `body: ${first.body}`);
  const baseAfterFirst = sidecarUpdatedAt(root, ingest.id);
  const { bakePath } = await import('../../src/lib/originals.ts');
  const bakeBefore = fs.readFileSync(bakePath(root, ingest.id));

  // Lost-ACK replay across a client restart: no db (no table row).
  // The queued entry carries a STALE base (the pre-first edit-start
  // value would be older), but the on-disk ops are byte-identical to
  // what it's replaying → pure replay → 2xx no-op, NOT a 409, and no
  // re-clobber. Use a clearly-stale base to prove the cheap no-op
  // precedes the 409 guard.
  const replay = await commit(app, ingest.id, ops, {
    'x-rkr-device-id': 'dev-D',
    'x-rkr-outbox-seq': '7',
    'x-rkr-sidecar-base': '2000-01-01T00:00:00.000Z'
  });
  assert.equal(replay.statusCode, 200, `pure replay must not 409: ${replay.body}`);
  assert.equal(sidecarUpdatedAt(root, ingest.id), baseAfterFirst, 'sidecar not rewritten');
  assert.deepEqual(fs.readFileSync(bakePath(root, ingest.id)), bakeBefore, 'bake unchanged');
});

test('commitImageEdit: first commit with a fresh matching baseline → 200, ops applied', async (t) => {
  const { root, app } = await setupNoDb(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpeg(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'x.jpg' }
  });
  const base = sidecarUpdatedAt(root, ingest.id);
  const ops = { ops: [{ type: 'crop', x: 5, y: 5, w: 300, h: 200 }], redoStack: [] };
  const res = await commit(
    app,
    ingest.id,
    ops,
    { 'x-rkr-device-id': 'dev-E', 'x-rkr-outbox-seq': '3', 'x-rkr-sidecar-base': base },
    await makeWebp(300, 200)
  );
  assert.equal(res.statusCode, 200, `first commit must apply: ${res.body}`);
  const sidecar = JSON.parse(
    fs.readFileSync(path.join(root, 'sidecars', `${ingest.id}.json`), 'utf8')
  );
  assert.deepEqual(sidecar.ops, ops.ops, 'ops applied');
});

test('commitImageEdit: absent baseline header (legacy entry) → no spurious 409', async (t) => {
  const { root, app } = await setupNoDb(t);
  const ingest = await ingestStream({
    stream: Readable.from([await makeJpeg(800, 600)]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'x.jpg' }
  });

  // A newer edit lands first, advancing the sidecar.
  await new Promise((r) => setTimeout(r, 20));
  const newerOps = { ops: [{ type: 'crop', x: 1, y: 1, w: 600, h: 400 }], redoStack: [] };
  const newer = await commit(app, ingest.id, newerOps, {}, await makeWebp(600, 400));
  assert.equal(newer.statusCode, 200);

  // A legacy queued entry (no x-rkr-sidecar-base) with different ops:
  // backward compatible → applied (no 409), last-write-wins as before.
  const legacyOps = { ops: [{ type: 'crop', x: 0, y: 0, w: 400, h: 300 }], redoStack: [] };
  const legacy = await commit(
    app,
    ingest.id,
    legacyOps,
    { 'x-rkr-device-id': 'dev-F', 'x-rkr-outbox-seq': '8' },
    await makeWebp(400, 300)
  );
  assert.equal(legacy.statusCode, 200, `absent-baseline must not 409: ${legacy.body}`);
  const sidecar = JSON.parse(
    fs.readFileSync(path.join(root, 'sidecars', `${ingest.id}.json`), 'utf8')
  );
  assert.deepEqual(sidecar.ops, legacyOps.ops, 'legacy entry applied (backward compatible)');
});
