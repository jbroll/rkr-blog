import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import {
  extFromProbeFormat,
  findExistingVideoOriginal,
  ingestVideoStream,
  VideoCapError,
  VideoProbeError,
  videoOriginalPath
} from '../../src/lib/video.ts';
import { readVideoSidecar, writeVideoSidecar } from '../../src/lib/video-sidecar.ts';

/** Fresh temp site root, removed after the test. */
function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-video-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Fresh temp dir used as a PATH entry holding a fake ffprobe executable. */
function freshBinDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-vin-'));
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

function prependPath(t: TestContext, dir: string): void {
  const prev = process.env.PATH;
  process.env.PATH = prev ? `${dir}:${prev}` : dir;
  t.after(() => {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
  });
}

test('ingestVideoStream ingests, probes, writes a sidecar, and dedups a second ingest', async (t) => {
  const root = freshSiteRoot(t);
  const binDir = freshBinDir(t);
  writeFakeProbe(binDir, { width: 1920, height: 1080, secs: 12 });
  prependPath(t, binDir);

  const bytes = Buffer.from('fake-video-bytes');
  const expectedId = crypto.createHash('sha256').update(bytes).digest('hex');

  const r1 = await ingestVideoStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'a.mp4' }
  });

  assert.match(r1.id, /^[0-9a-f]{64}$/);
  assert.equal(r1.id, expectedId);
  assert.equal(r1.deduplicated, false);
  assert.equal(r1.bytes, bytes.length);
  // mp4-family probe format maps to ext mp4 (see extFromProbeFormat).
  assert.equal(r1.ext, 'mp4');
  assert.equal(r1.durationMs, 12000);
  assert.equal(r1.width, 1920);
  assert.equal(r1.height, 1080);
  assert.equal(r1.path, videoOriginalPath(root, r1.id, 'mp4'));
  assert.ok(fs.existsSync(r1.path));
  assert.equal(fs.readFileSync(r1.path).length, bytes.length, 'on-disk bytes match the upload');

  const sidecar = await readVideoSidecar(root, r1.id);
  assert.ok(sidecar);
  assert.equal(sidecar.original, r1.id);
  assert.equal(sidecar.source.kind, 'upload');
  assert.equal(sidecar.source.originalName, 'a.mp4');
  assert.equal(sidecar.source.uploadFormat, 'mov,mp4,m4a,3gp,3g2,mj2');
  assert.equal(sidecar.source.storedHash, r1.id);
  assert.equal(sidecar.source.uploadBytes, bytes.length);
  assert.equal(sidecar.source.uploadWidth, 1920);
  assert.equal(sidecar.source.uploadHeight, 1080);
  assert.equal(sidecar.source.durationMs, 12000);
  assert.equal(sidecar.poster.timeMs, 1000, 'poster defaults to min(1000, durationMs/2)');
  assert.deepEqual(sidecar.ops, []);
  assert.deepEqual(sidecar.outputs, [{ format: 'mp4', codec: 'h264/aac' }]);

  // Byte-identical second ingest dedups without writing a second file.
  const r2 = await ingestVideoStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'a.mp4' }
  });
  assert.equal(r2.id, r1.id);
  assert.equal(r2.deduplicated, true);
  assert.equal(r2.path, r1.path);
  assert.equal(fs.readdirSync(path.dirname(r1.path)).length, 1, 'only one original on disk');
});

test('ingestVideoStream dedup preserves existing sidecar ops', async (t) => {
  const root = freshSiteRoot(t);
  const binDir = freshBinDir(t);
  writeFakeProbe(binDir);
  prependPath(t, binDir);
  const bytes = Buffer.from('editable-video');

  const r1 = await ingestVideoStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'a.mp4' }
  });

  const sidecar = await readVideoSidecar(root, r1.id);
  assert.ok(sidecar);
  sidecar.ops = [{ kind: 'trim', startMs: 0, endMs: 5000 }];
  await writeVideoSidecar(root, r1.id, sidecar);

  const r2 = await ingestVideoStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'b.mp4' }
  });
  assert.equal(r2.deduplicated, true);
  const after = await readVideoSidecar(root, r1.id);
  assert.deepEqual(after?.ops, [{ kind: 'trim', startMs: 0, endMs: 5000 }]);
});

test('ingestVideoStream records url source provenance and explicit fetchedAt', async (t) => {
  const root = freshSiteRoot(t);
  const binDir = freshBinDir(t);
  writeFakeProbe(binDir);
  prependPath(t, binDir);

  const r = await ingestVideoStream({
    stream: Readable.from([Buffer.from('url-video')]),
    siteRoot: root,
    source: { kind: 'url', originalName: 'clip.mp4', fetchedAt: '2026-08-28T00:00:00Z' }
  });

  const sidecar = await readVideoSidecar(root, r.id);
  assert.ok(sidecar);
  assert.equal(sidecar.source.kind, 'url');
  assert.equal(sidecar.source.fetchedAt, '2026-08-28T00:00:00Z');
});

test('ingestVideoStream rejects over caps with VideoCapError(413)', async (t) => {
  const root = freshSiteRoot(t);
  const binDir = freshBinDir(t);
  prependPath(t, binDir);
  const bytes = Buffer.from('x'.repeat(100));

  // Bytes check fires first, so any probe works.
  writeFakeProbe(binDir, { secs: 10 });
  await assert.rejects(
    ingestVideoStream({
      stream: Readable.from([bytes]),
      siteRoot: root,
      source: { kind: 'upload', originalName: 'a.mp4' },
      caps: { maxBytes: 1 }
    }),
    (err: unknown) =>
      err instanceof VideoCapError && err.statusCode === 413 && /maxBytes/.test(err.message)
  );
  // Duration check: 400s beats the 1000ms cap.
  writeFakeProbe(binDir, { secs: 400 });
  await assert.rejects(
    ingestVideoStream({
      stream: Readable.from([bytes]),
      siteRoot: root,
      source: { kind: 'upload', originalName: 'a.mp4' },
      caps: { maxDurationMs: 1000 }
    }),
    (err: unknown) =>
      err instanceof VideoCapError && err.statusCode === 413 && /maxDurationMs/.test(err.message)
  );
  // Width check needs a duration under the default cap so the long-edge
  // (1920 > 320) is what fires.
  writeFakeProbe(binDir, { width: 1920, height: 1080, secs: 10 });
  await assert.rejects(
    ingestVideoStream({
      stream: Readable.from([bytes]),
      siteRoot: root,
      source: { kind: 'upload', originalName: 'a.mp4' },
      caps: { maxWidth: 320 }
    }),
    (err: unknown) =>
      err instanceof VideoCapError && err.statusCode === 413 && /maxWidth/.test(err.message)
  );

  const tmpDir = path.join(root, 'originals', 'videos', '.tmp');
  if (fs.existsSync(tmpDir)) {
    assert.deepEqual(fs.readdirSync(tmpDir), [], 'no tmp file should remain after a cap rejection');
  }
});

test('ingestVideoStream applies DEFAULT_VIDEO_CAPS when caps are omitted', async (t) => {
  const root = freshSiteRoot(t);
  const binDir = freshBinDir(t);
  // 400s = 400000ms > DEFAULT_VIDEO_CAPS.maxDurationMs (300000).
  writeFakeProbe(binDir, { secs: 400 });
  prependPath(t, binDir);

  await assert.rejects(
    ingestVideoStream({
      stream: Readable.from([Buffer.from('long-video')]),
      siteRoot: root,
      source: { kind: 'upload', originalName: 'a.mp4' }
    }),
    (err: unknown) => err instanceof VideoCapError && err.statusCode === 413
  );
});

test('ingestVideoStream probe failure rejects with VideoProbeError(422) and cleans up', async (t) => {
  const root = freshSiteRoot(t);
  const binDir = freshBinDir(t);
  fs.writeFileSync(
    path.join(binDir, 'ffprobe'),
    '#!/bin/sh\necho "Invalid data found" >&2; exit 1\n',
    {
      mode: 0o755
    }
  );
  prependPath(t, binDir);

  await assert.rejects(
    ingestVideoStream({
      stream: Readable.from([Buffer.from('not-a-video')]),
      siteRoot: root,
      source: { kind: 'upload', originalName: 'bad.mp4' }
    }),
    (err: unknown) => err instanceof VideoProbeError && err.statusCode === 422
  );

  const tmpDir = path.join(root, 'originals', 'videos', '.tmp');
  if (fs.existsSync(tmpDir)) {
    assert.deepEqual(fs.readdirSync(tmpDir), [], 'no tmp file should remain after a probe failure');
  }
});

test('ingestVideoStream cleans up the tmp file and rethrows on stream failure', async (t) => {
  const root = freshSiteRoot(t);
  const binDir = freshBinDir(t);
  writeFakeProbe(binDir);
  prependPath(t, binDir);

  const broken = new Readable({
    read() {
      this.destroy(new Error('boom'));
    }
  });
  await assert.rejects(
    ingestVideoStream({
      stream: broken,
      siteRoot: root,
      source: { kind: 'upload', originalName: 'x.mp4' }
    }),
    /boom/
  );

  const tmpDir = path.join(root, 'originals', 'videos', '.tmp');
  if (fs.existsSync(tmpDir)) {
    assert.deepEqual(
      fs.readdirSync(tmpDir),
      [],
      'no tmp file should remain after a stream failure'
    );
  }
});

test('extFromProbeFormat maps the mp4 container family to mp4', () => {
  assert.equal(extFromProbeFormat('mov,mp4,m4a,3gp,3g2,mj2'), 'mp4');
  assert.equal(extFromProbeFormat('m4v'), 'mp4');
  assert.equal(extFromProbeFormat('matroska,webm'), 'matroska');
  assert.equal(extFromProbeFormat('webm'), 'webm');
  assert.equal(extFromProbeFormat('MOV,MP4'), 'mp4');
});

test('videoOriginalPath shards under originals/videos', () => {
  const id = 'a'.repeat(64);
  assert.equal(
    videoOriginalPath('/site', id, 'mp4'),
    path.join('/site', 'originals', 'videos', 'aa', 'aa', `${id}.mp4`)
  );
});

test('findExistingVideoOriginal finds prior ingests and misses fresh ids', async (t) => {
  const root = freshSiteRoot(t);
  const binDir = freshBinDir(t);
  writeFakeProbe(binDir);
  prependPath(t, binDir);

  const r1 = await ingestVideoStream({
    stream: Readable.from([Buffer.from('find-me')]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'a.mp4' }
  });
  assert.deepEqual(await findExistingVideoOriginal(root, r1.id), { path: r1.path, ext: 'mp4' });

  // A webm-family probe lands on the native container name; the helper finds it too.
  writeFakeProbe(binDir, { format: 'matroska,webm' });
  const r2 = await ingestVideoStream({
    stream: Readable.from([Buffer.from('find-me-too')]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'b.webm' }
  });
  assert.equal(r2.ext, 'matroska');
  assert.deepEqual(await findExistingVideoOriginal(root, r2.id), {
    path: r2.path,
    ext: 'matroska'
  });

  assert.equal(await findExistingVideoOriginal(root, 'c'.repeat(64)), undefined);
});
