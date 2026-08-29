// GET /video/:filename and GET /video/poster/:filename — the serving
// half of the video pipeline. Mirrors the /img route tests: a seeded
// sidecar + original, a fake `ffmpeg` on PATH when a render is needed,
// and inject() against a real buildApp instance. Guards the URL
// contract (regex, stale-ophash 404, dims guard) and the Range/206
// behavior the <video> element depends on.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { videoCachePaths } from '../../src/lib/video-render.ts';
import {
  CURRENT_VIDEO_SIDE_VERSION,
  readVideoSidecar,
  type VideoSidecar,
  writeVideoSidecar
} from '../../src/lib/video-sidecar.ts';
import { buildApp } from '../../src/server.ts';

const HEX64 = 'a'.repeat(64);

/** Fresh temp site root with the video trees, removed after the test. */
function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-vroute-'));
  for (const sub of ['originals/videos', 'sidecars/videos', 'cache/video', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function validSidecar(overrides: Partial<VideoSidecar> = {}): VideoSidecar {
  return {
    version: CURRENT_VIDEO_SIDE_VERSION,
    original: HEX64,
    source: {
      kind: 'upload',
      fetchedAt: '2026-08-28T00:00:00Z',
      originalName: 'a.mp4',
      storedHash: 'b'.repeat(64),
      uploadFormat: 'mp4',
      uploadBytes: 100,
      uploadWidth: 640,
      uploadHeight: 480,
      durationMs: 10000,
      probe: { codecVideo: 'h264', codecAudio: 'aac' }
    },
    ops: [],
    outputs: [{ format: 'mp4', codec: 'h264/aac' }],
    poster: { timeMs: 1000 },
    ...overrides
  };
}

/** Seed an original video + sidecar for a 64-hex id at its sharded path. */
async function seedVideo(root: string, id: string): Promise<void> {
  const dir = path.join(root, 'originals', 'videos', id.slice(0, 2), id.slice(2, 4));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.mp4`), Buffer.from('fake-original-video'));
  await writeVideoSidecar(root, id, validSidecar());
}

async function setup(t: TestContext, opts: { renderBudgetMs?: number } = {}) {
  const root = freshSiteRoot(t);
  const db = open(':memory:');
  migrate(db);
  t.after(() => db.close());

  // 40ms budget: a fake ffmpeg that holds the transcode open reliably
  // busts the budget (202) while an instant one lands inside it (200).
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    renderBudgetMs: opts.renderBudgetMs ?? 40
  });
  t.after(async () => {
    await app.close();
  });

  await seedVideo(root, HEX64);
  return { root, db, app, id: HEX64 };
}

// ---- fake ffmpeg on PATH ------------------------------------------------

function freshBinDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-vroute-bin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function prependPath(t: TestContext, dir: string): void {
  const prev = process.env.PATH;
  process.env.PATH = prev ? `${dir}:${prev}` : dir;
  t.after(() => {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
  });
}

/** Fake ffmpeg: records a line per invocation in RKR_COUNT_FILE, runs
 * `extra` shell (e.g. "sleep 0.4" to hold the transcode open), then writes
 * fake bytes to its last arg (the output path). */
function writeFakeFfmpeg(dir: string, extra = ''): void {
  fs.writeFileSync(
    path.join(dir, 'ffmpeg'),
    [
      '#!/bin/sh',
      '[ -n "$RKR_COUNT_FILE" ] && printf \'x\\n\' >> "$RKR_COUNT_FILE"',
      extra,
      'for last do :; done',
      'printf \'fake-video\' > "$last"',
      'exit 0'
    ].join('\n'),
    { mode: 0o755 }
  );
}

function recordCountTo(t: TestContext, dir: string): string {
  const countFile = path.join(dir, 'count.txt');
  process.env.RKR_COUNT_FILE = countFile;
  t.after(() => {
    delete process.env.RKR_COUNT_FILE;
  });
  return countFile;
}

function countLines(file: string): number {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length;
  } catch {
    return 0; // file not created yet
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Write both halves of a derivative into cache/video so the render fast
 * path short-circuits (no ffmpeg needed). Returns the byte content. */
function seedCache(root: string, id: string): Buffer {
  const p = videoCachePaths(root, id, [], 1000);
  fs.mkdirSync(path.dirname(p.videoPath), { recursive: true });
  const bytes = Buffer.from('0123456789abcdefghij'); // 20 bytes
  fs.writeFileSync(p.videoPath, bytes);
  fs.writeFileSync(p.posterPath, bytes);
  return bytes;
}

// ---- contract: 404s ----------------------------------------------------

test('404 on a filename that does not match the shape', async (t) => {
  const { app } = await setup(t);
  for (const url of ['/video/bad', '/video/poster/bad', `/video/${HEX64}.zzz.mp4`]) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 404, `${url} should 404`);
  }
});

test('404 when the original id is unknown', async (t) => {
  const { app } = await setup(t);
  const id = 'b'.repeat(64);
  const res = await app.inject({ method: 'GET', url: `/video/${id}.${'c'.repeat(12)}.mp4` });
  assert.equal(res.statusCode, 404);
  assert.match(res.json<{ error: string }>().error, /unknown original/);
});

test('404 when the ophash does not match the current sidecar', async (t) => {
  const { app, root, id } = await setup(t);
  const url = `/video/${id}.${videoCachePaths(root, id, [], 1000).videoOphash}.mp4`;

  // Make the sidecar state differ so the URL ophash is stale.
  const sidecar = await readVideoSidecar(root, id);
  assert.ok(sidecar);
  sidecar.ops = [{ kind: 'trim', startMs: 0, endMs: 5000 }];
  await writeVideoSidecar(root, id, sidecar);

  const res = await app.inject({ method: 'GET', url });
  assert.equal(res.statusCode, 404);
});

test('422 when the source is too small to derive from', async (t) => {
  const { app, root, id } = await setup(t);
  const sidecar = await readVideoSidecar(root, id);
  assert.ok(sidecar);
  sidecar.source.uploadWidth = 4;
  sidecar.source.uploadHeight = 4;
  await writeVideoSidecar(root, id, sidecar);

  const url = `/video/${id}.${videoCachePaths(root, id, [], 1000).videoOphash}.mp4`;
  const res = await app.inject({ method: 'GET', url });
  assert.equal(res.statusCode, 422);
  const body = res.json<{ error: string; width: number; height: number; min: number }>();
  assert.match(body.error, /too small/);
  assert.equal(body.min, 16);
});

// ---- render flow: 202 -> 200 -------------------------------------------

test('202 while rendering, then 200 from cache once the derivative lands', async (t) => {
  const { app, root, id } = await setup(t);
  const binDir = freshBinDir(t);
  writeFakeFfmpeg(binDir, 'sleep 0.3'); // hold the transcode past the 40ms budget
  prependPath(t, binDir);
  const p = videoCachePaths(root, id, [], 1000);
  const url = `/video/${id}.${p.videoOphash}.mp4`;

  const first = await app.inject({ method: 'GET', url });
  assert.equal(first.statusCode, 202);
  assert.equal(first.headers['retry-after'], '2');

  await waitFor(() => fs.existsSync(p.videoPath) && fs.existsSync(p.posterPath));

  const second = await app.inject({ method: 'GET', url });
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers['content-type'], 'video/mp4');
  assert.equal(second.headers['accept-ranges'], 'bytes');
  assert.match(second.headers['cache-control'] ?? '', /immutable/);
});

test('poster route renders on miss and serves the poster file', async (t) => {
  // Generous budget: this test's point is the poster route's render +
  // serve path, not the timeout. The c8-instrumented ffmpeg spawns can
  // take ~100ms+ under coverage, so a 40ms budget would flake here.
  const { app, root, id } = await setup(t, { renderBudgetMs: 5000 });
  const binDir = freshBinDir(t);
  writeFakeFfmpeg(binDir); // instant: completes inside the budget
  prependPath(t, binDir);
  const p = videoCachePaths(root, id, [], 1000);
  const url = `/video/poster/${id}.${p.posterOphash}.jpg`;

  const res = await app.inject({ method: 'GET', url });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.ok(fs.existsSync(p.posterPath));
  assert.ok(fs.existsSync(p.videoPath), 'poster render also produces the mp4');
});

test('concurrent requests for the same derivative share one render', async (t) => {
  const { app, root, id } = await setup(t);
  const binDir = freshBinDir(t);
  writeFakeFfmpeg(binDir, 'sleep 0.4');
  prependPath(t, binDir);
  const countFile = recordCountTo(t, binDir);
  const p = videoCachePaths(root, id, [], 1000);
  const url = `/video/${id}.${p.videoOphash}.mp4`;

  const [r1, r2] = await Promise.all([
    app.inject({ method: 'GET', url }),
    app.inject({ method: 'GET', url })
  ]);
  assert.equal(r1.statusCode, 202);
  assert.equal(r2.statusCode, 202);

  await waitFor(() => fs.existsSync(p.videoPath) && fs.existsSync(p.posterPath));
  assert.equal(countLines(countFile), 2, 'one transcode + one poster across both requests');
});

test('render failure returns 500', async (t) => {
  const { app, root, id } = await setup(t);
  const binDir = freshBinDir(t);
  fs.writeFileSync(path.join(binDir, 'ffmpeg'), '#!/bin/sh\necho "boom" >&2\nexit 1\n', {
    mode: 0o755
  });
  prependPath(t, binDir);

  const url = `/video/${id}.${videoCachePaths(root, id, [], 1000).videoOphash}.mp4`;
  const res = await app.inject({ method: 'GET', url });
  assert.equal(res.statusCode, 500);
});

// ---- Range / 206 -------------------------------------------------------

test('Range request on a cache hit serves 206 with Content-Range', async (t) => {
  const { app, root, id } = await setup(t);
  const bytes = seedCache(root, id);
  const url = `/video/${id}.${videoCachePaths(root, id, [], 1000).videoOphash}.mp4`;

  const res = await app.inject({ method: 'GET', url, headers: { range: 'bytes=0-9' } });
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-range'], 'bytes 0-9/20');
  assert.equal(res.headers['content-length'], '10');
  assert.equal(res.headers['content-type'], 'video/mp4');
  assert.equal(res.body, bytes.subarray(0, 10).toString());
});

test('suffix Range (last N bytes) serves 206', async (t) => {
  const { app, root, id } = await setup(t);
  const bytes = seedCache(root, id);
  const url = `/video/${id}.${videoCachePaths(root, id, [], 1000).videoOphash}.mp4`;

  const res = await app.inject({ method: 'GET', url, headers: { range: 'bytes=-5' } });
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-range'], 'bytes 15-19/20');
  assert.equal(res.body, bytes.subarray(15, 20).toString());
});

test('unsatisfiable or malformed Range serves 416', async (t) => {
  const { app, root, id } = await setup(t);
  seedCache(root, id);
  const url = `/video/${id}.${videoCachePaths(root, id, [], 1000).videoOphash}.mp4`;

  for (const range of ['bytes=100-200', 'bytes=10-5', 'bytes=-0', 'bytes=abc', 'bytes=-']) {
    const res = await app.inject({ method: 'GET', url, headers: { range } });
    assert.equal(res.statusCode, 416, `${range} should 416`);
    assert.equal(res.headers['content-range'], 'bytes */20', `${range} content-range`);
  }
});
