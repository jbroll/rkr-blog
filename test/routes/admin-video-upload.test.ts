// POST /admin/upload/video + POST /admin/video/:id/trim — the admin
// half of the video pipeline (video spec Task 8). Mirrors the image
// upload tests: multipart bytes, a fake `ffprobe` on PATH for the
// ingest probe, a fake `ffmpeg` on PATH for the derivative render.
// Guards the URL contract (64-hex id, /video/... + /video/poster/...
// URLs) and the trim endpoint's validation against the sidecar duration.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { videoCachePaths } from '../../src/lib/video-render.ts';
import {
  CURRENT_VIDEO_SIDE_VERSION,
  readVideoSidecar,
  type VideoSidecar,
  writeVideoSidecar
} from '../../src/lib/video-sidecar.ts';
import { buildApp } from '../../src/server.ts';
import { buildMultipart } from '../helpers/multipart.ts';

const HEX64 = 'a'.repeat(64);

/** Fresh temp site root with the video trees, removed after the test. */
function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-admin-video-'));
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

function freshBinDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-admin-video-bin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Fake ffprobe that reports the given probe, ignoring the input file. */
function writeFakeProbe(
  dir: string,
  opts: { width?: number; height?: number; secs?: number; format?: string } = {}
): void {
  const { width = 640, height = 480, secs = 10, format = 'mov,mp4,m4a,3gp,3g2,mj2' } = opts;
  const json = JSON.stringify({
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width, height, duration: String(secs) }
    ],
    format: { format_name: format, duration: String(secs) }
  });
  fs.writeFileSync(path.join(dir, 'ffprobe'), `#!/bin/sh\ncat <<'EOF'\n${json}\nEOF\n`, {
    mode: 0o755
  });
}

/** Fake ffmpeg: writes fake bytes to its last arg (the output path). */
function writeFakeFfmpeg(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'ffmpeg'),
    ['#!/bin/sh', 'for last do :; done', 'printf \'fake-video\' > "$last"', 'exit 0'].join('\n'),
    { mode: 0o755 }
  );
}

function prependPath(t: TestContext, dir: string): void {
  const prev = process.env.PATH;
  process.env.PATH = prev ? `${dir}:${prev}` : dir;
  t.after(() => {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
  });
}

interface UploadVideoBody {
  id: string;
  videoUrl: string;
  posterUrl: string;
  durationMs: number;
  width: number;
  height: number;
}

// ---- POST /admin/upload/video ------------------------------------------

test('POST /admin/upload/video ingests, renders, and returns urls', async (t) => {
  const root = freshSiteRoot(t);
  const binDir = freshBinDir(t);
  writeFakeProbe(binDir);
  writeFakeFfmpeg(binDir);
  prependPath(t, binDir);

  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const bytes = Buffer.from('fake-mp4-upload-bytes');
  const expectedId = crypto.createHash('sha256').update(bytes).digest('hex');
  const { payload, headers } = buildMultipart({
    filename: 'clip.mp4',
    contentType: 'video/mp4',
    bytes
  });

  const res = await app.inject({ method: 'POST', url: '/admin/upload/video', payload, headers });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<UploadVideoBody>();
  assert.match(body.id, /^[0-9a-f]{64}$/);
  assert.equal(body.id, expectedId);
  assert.match(body.videoUrl, new RegExp(`^/video/${expectedId}\\.[0-9a-f]{12}\\.mp4$`));
  assert.match(body.posterUrl, new RegExp(`^/video/poster/${expectedId}\\.[0-9a-f]{12}\\.jpg$`));
  assert.equal(body.durationMs, 10000);
  assert.equal(body.width, 640);
  assert.equal(body.height, 480);

  // Original + sidecar + both derivative halves exist on disk.
  const originalPath = path.join(
    root,
    'originals',
    'videos',
    expectedId.slice(0, 2),
    expectedId.slice(2, 4),
    `${expectedId}.mp4`
  );
  assert.ok(fs.existsSync(originalPath));
  const sidecar = await readVideoSidecar(root, expectedId);
  assert.ok(sidecar);
  assert.equal(sidecar.source.originalName, 'clip.mp4');
  const p = videoCachePaths(root, expectedId, [], sidecar.poster.timeMs);
  assert.ok(fs.existsSync(p.videoPath), 'transcoded mp4 exists');
  assert.ok(fs.existsSync(p.posterPath), 'poster jpg exists');
});

test('POST /admin/upload/video dedupes a byte-identical re-upload', async (t) => {
  const root = freshSiteRoot(t);
  const binDir = freshBinDir(t);
  writeFakeProbe(binDir);
  writeFakeFfmpeg(binDir);
  prependPath(t, binDir);

  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const bytes = Buffer.from('dedupe-me');
  const { payload, headers } = buildMultipart({
    filename: 'a.mp4',
    contentType: 'video/mp4',
    bytes
  });

  const r1 = await app.inject({ method: 'POST', url: '/admin/upload/video', payload, headers });
  assert.equal(r1.statusCode, 200, r1.body);
  const r2 = await app.inject({ method: 'POST', url: '/admin/upload/video', payload, headers });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal(r2.json<UploadVideoBody>().id, r1.json<UploadVideoBody>().id);
  const dir = path.join(
    root,
    'originals',
    'videos',
    r1.json<UploadVideoBody>().id.slice(0, 2),
    r1.json<UploadVideoBody>().id.slice(2, 4)
  );
  assert.equal(fs.readdirSync(dir).length, 1, 'only one original on disk');
});

test('POST /admin/upload/video rejects unprobeable payloads with 422', async (t) => {
  const root = freshSiteRoot(t);
  const binDir = freshBinDir(t);
  fs.writeFileSync(
    path.join(binDir, 'ffprobe'),
    '#!/bin/sh\necho "Invalid data found" >&2; exit 1\n',
    { mode: 0o755 }
  );
  prependPath(t, binDir);

  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const { payload, headers } = buildMultipart({
    filename: 'bad.mp4',
    contentType: 'video/mp4',
    bytes: Buffer.from('not-a-video')
  });
  const res = await app.inject({ method: 'POST', url: '/admin/upload/video', payload, headers });
  assert.equal(res.statusCode, 422);
  assert.match(res.json<{ error: string }>().error, /probe failed/);
});

test('POST /admin/upload/video rejects over-cap durations with 413', async (t) => {
  const root = freshSiteRoot(t);
  const binDir = freshBinDir(t);
  // 400s = 400000ms > DEFAULT_VIDEO_CAPS.maxDurationMs (300000).
  writeFakeProbe(binDir, { secs: 400 });
  prependPath(t, binDir);

  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const { payload, headers } = buildMultipart({
    filename: 'long.mp4',
    contentType: 'video/mp4',
    bytes: Buffer.from('a-long-video')
  });
  const res = await app.inject({ method: 'POST', url: '/admin/upload/video', payload, headers });
  assert.equal(res.statusCode, 413);
});

test('POST /admin/upload/video returns 400 when no file part is present', async (t) => {
  const root = freshSiteRoot(t);
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // Field-only multipart, no file (same shape as the image upload test).
  const boundary = '----rkrtest';
  const payload = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\nhi\r\n--${boundary}--\r\n`
  );
  const res = await app.inject({
    method: 'POST',
    url: '/admin/upload/video',
    payload,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(payload.length)
    }
  });
  assert.equal(res.statusCode, 400);
});

// ---- POST /admin/video/:id/trim ----------------------------------------

test('POST /admin/video/:id/trim validates the range against duration', async (t) => {
  const root = freshSiteRoot(t);
  await writeVideoSidecar(root, HEX64, validSidecar());
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const post = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/admin/video/${HEX64}/trim`,
      payload
    });

  // start >= end → 422.
  const reversed = await post({ startMs: 5000, endMs: 5000, posterTimeMs: 1000 });
  assert.equal(reversed.statusCode, 422, reversed.body);
  // end beyond the sidecar duration → 422.
  const beyond = await post({ startMs: 0, endMs: 20000, posterTimeMs: 1000 });
  assert.equal(beyond.statusCode, 422, beyond.body);
  // poster beyond the duration → 422.
  const posterBeyond = await post({ startMs: 0, endMs: 5000, posterTimeMs: 15000 });
  assert.equal(posterBeyond.statusCode, 422, posterBeyond.body);
  // non-numeric values → 422.
  const nonNumeric = await post({ startMs: 'soon', endMs: 5000, posterTimeMs: 1000 });
  assert.equal(nonNumeric.statusCode, 422, nonNumeric.body);
});

test('POST /admin/video/:id/trim persists ops and returns new urls', async (t) => {
  const root = freshSiteRoot(t);
  await writeVideoSidecar(root, HEX64, validSidecar());
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: `/admin/video/${HEX64}/trim`,
    payload: { startMs: 2000, endMs: 9000, posterTimeMs: 3000 }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<{ videoUrl: string; posterUrl: string }>();

  const sidecar = await readVideoSidecar(root, HEX64);
  assert.deepEqual(sidecar?.ops, [{ kind: 'trim', startMs: 2000, endMs: 9000 }]);
  assert.equal(sidecar?.poster.timeMs, 3000);

  const p = videoCachePaths(root, HEX64, [{ kind: 'trim', startMs: 2000, endMs: 9000 }], 3000);
  assert.equal(body.videoUrl, `/video/${HEX64}.${p.videoOphash}.mp4`);
  assert.equal(body.posterUrl, `/video/poster/${HEX64}.${p.posterOphash}.jpg`);
});

test('POST /admin/video/:id/trim clears ops for the full range and drops redoStack', async (t) => {
  const root = freshSiteRoot(t);
  await writeVideoSidecar(
    root,
    HEX64,
    validSidecar({
      ops: [{ kind: 'trim', startMs: 2000, endMs: 45000 }],
      redoStack: [{ kind: 'trim', startMs: 0, endMs: 10000 }]
    })
  );
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  // Full 0..durationMs range = the untrimmed video → ops cleared.
  const res = await app.inject({
    method: 'POST',
    url: `/admin/video/${HEX64}/trim`,
    payload: { startMs: 0, endMs: 10000, posterTimeMs: 500 }
  });
  assert.equal(res.statusCode, 200, res.body);

  const sidecar = await readVideoSidecar(root, HEX64);
  assert.deepEqual(sidecar?.ops, []);
  assert.equal(sidecar?.poster.timeMs, 500);
  assert.equal(sidecar?.redoStack, undefined, 'redoStack is cleared');
});

test('POST /admin/video/:id/trim rejects unknown ids and malformed ids', async (t) => {
  const root = freshSiteRoot(t);
  await writeVideoSidecar(root, HEX64, validSidecar());
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const missing = await app.inject({
    method: 'POST',
    url: `/admin/video/${'b'.repeat(64)}/trim`,
    payload: { startMs: 0, endMs: 1000, posterTimeMs: 500 }
  });
  assert.equal(missing.statusCode, 404);

  const malformed = await app.inject({
    method: 'POST',
    url: '/admin/video/not-a-hash/trim',
    payload: { startMs: 0, endMs: 1000, posterTimeMs: 500 }
  });
  assert.equal(malformed.statusCode, 400);
});
