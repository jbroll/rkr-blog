import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import type { VideoOp, VideoSidecar } from '../../src/lib/video-sidecar.ts';
import {
  CURRENT_VIDEO_SIDE_VERSION,
  makeDefaultVideoSidecar,
  readVideoSidecar,
  validateVideoSidecar,
  videoSidecarPath,
  writeVideoSidecar
} from '../../src/lib/video-sidecar.ts';

const HEX64 = 'a'.repeat(64);

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-vside-'));
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

test('validateVideoSidecar accepts the minimal valid sidecar', () => {
  assert.deepEqual(validateVideoSidecar(validSidecar()), { ok: true });
});

test('validateVideoSidecar rejects unsupported version', () => {
  const bad = { ...validSidecar(), version: 2 } as unknown;
  const r = validateVideoSidecar(bad);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /version/);
});

test('readVideoSidecar returns null for a missing sidecar', async (t) => {
  const root = freshSiteRoot(t);
  assert.equal(await readVideoSidecar(root, HEX64), null);
});

test('writeVideoSidecar/readVideoSidecar round-trips data exactly', async (t) => {
  const root = freshSiteRoot(t);
  const trim: VideoOp = { kind: 'trim', startMs: 2000, endMs: 45500 };
  const data = validSidecar({
    ops: [trim],
    redoStack: [{ kind: 'trim', startMs: 0, endMs: 1000 }],
    poster: { timeMs: 500 }
  });
  await writeVideoSidecar(root, HEX64, data);
  assert.deepEqual(await readVideoSidecar(root, HEX64), data);
});

test('writeVideoSidecar places file under sidecars/videos/<id>.json', async (t) => {
  const root = freshSiteRoot(t);
  await writeVideoSidecar(root, HEX64, validSidecar());
  assert.ok(fs.existsSync(videoSidecarPath(root, HEX64)));
  assert.equal(
    videoSidecarPath(root, HEX64),
    path.join(root, 'sidecars', 'videos', `${HEX64}.json`)
  );
});

test('writeVideoSidecar rejects mismatched id', async (t) => {
  const root = freshSiteRoot(t);
  await assert.rejects(writeVideoSidecar(root, 'b'.repeat(64), validSidecar()), /id mismatch/);
});

test('writeVideoSidecar rejects invalid data without leaving a temp file', async (t) => {
  const root = freshSiteRoot(t);
  await assert.rejects(
    writeVideoSidecar(root, HEX64, { version: 1 } as unknown as VideoSidecar),
    /invalid data/
  );

  const dir = path.join(root, 'sidecars', 'videos');
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    assert.ok(!files.some((f) => f.endsWith('.tmp')), `temp file leaked: ${files}`);
  }
});

test('readVideoSidecar rethrows non-ENOENT read errors', async (t) => {
  const root = freshSiteRoot(t);
  const dir = path.join(root, 'sidecars', 'videos');
  fs.mkdirSync(dir, { recursive: true });
  // A directory named like the sidecar file makes readFile throw EISDIR,
  // which must propagate rather than be swallowed by the ENOENT guard.
  fs.mkdirSync(path.join(dir, `${HEX64}.json`));
  await assert.rejects(
    readVideoSidecar(root, HEX64),
    (err: NodeJS.ErrnoException) => err.code === 'EISDIR'
  );
});

test('validateVideoSidecar rejects non-object input', () => {
  for (const bad of [null, undefined, 'x', 42, [], true]) {
    const r = validateVideoSidecar(bad);
    assert.equal(r.ok, false);
  }
});

test('validateVideoSidecar requires 64-char lowercase hex original', () => {
  for (const bad of ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), 123]) {
    const data = { ...validSidecar(), original: bad } as unknown;
    const r = validateVideoSidecar(data);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /original/);
  }
});

test('validateVideoSidecar requires source field types', () => {
  const base = validSidecar();
  const cases: unknown[] = [
    { ...base, source: null },
    { ...base, source: {} },
    { ...base, source: { ...base.source, kind: 7 } },
    { ...base, source: { ...base.source, fetchedAt: 1 } },
    { ...base, source: { ...base.source, originalName: 7 } },
    { ...base, source: { ...base.source, storedHash: 'not-hex' } },
    { ...base, source: { ...base.source, uploadFormat: 7 } },
    { ...base, source: { ...base.source, uploadBytes: 'many' } },
    { ...base, source: { ...base.source, uploadWidth: 'wide' } },
    { ...base, source: { ...base.source, uploadHeight: 'tall' } },
    { ...base, source: { ...base.source, durationMs: 'long' } },
    { ...base, source: { ...base.source, probe: null } },
    { ...base, source: { ...base.source, probe: { codecVideo: 'h264' } } },
    { ...base, source: { ...base.source, probe: { codecVideo: 7, codecAudio: 'aac' } } },
    { ...base, source: { ...base.source, probe: { codecVideo: 'h264', codecAudio: 7 } } }
  ];
  for (const data of cases) {
    const r = validateVideoSidecar(data);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /source/);
  }
});

test('validateVideoSidecar requires ops array and optional redoStack array', () => {
  const base = validSidecar();
  assert.equal(validateVideoSidecar({ ...base, ops: 'no' } as unknown).ok, false);
  assert.equal(validateVideoSidecar({ ...base, ops: null } as unknown).ok, false);
  assert.equal(validateVideoSidecar({ ...base, redoStack: 'no' } as unknown).ok, false);
});

test('validateVideoSidecar requires outputs to be a single mp4 entry', () => {
  const base = validSidecar();
  assert.equal(validateVideoSidecar({ ...base, outputs: [] } as unknown).ok, false);
  assert.equal(
    validateVideoSidecar({ ...base, outputs: [{ format: 'mp4' }, { format: 'mp4' }] } as unknown)
      .ok,
    false
  );
  assert.equal(validateVideoSidecar({ ...base, outputs: [5] } as unknown).ok, false);
  assert.equal(
    validateVideoSidecar({ ...base, outputs: [{ format: 'webm' }] } as unknown).ok,
    false
  );
});

test('validateVideoSidecar requires poster.timeMs number', () => {
  const base = validSidecar();
  assert.equal(validateVideoSidecar({ ...base, poster: null } as unknown).ok, false);
  assert.equal(validateVideoSidecar({ ...base, poster: {} } as unknown).ok, false);
  assert.equal(validateVideoSidecar({ ...base, poster: { timeMs: 'soon' } } as unknown).ok, false);
});

test('makeDefaultVideoSidecar builds a valid default sidecar', () => {
  const sc = makeDefaultVideoSidecar(HEX64, {
    source: { kind: 'upload', originalName: 'clip.mov' },
    probe: {
      width: 640,
      height: 480,
      durationMs: 10000,
      codecVideo: 'h264',
      codecAudio: 'aac',
      format: 'mov'
    },
    bytes: 100,
    storedHash: HEX64
  });
  assert.deepEqual(validateVideoSidecar(sc), { ok: true });
  assert.deepEqual(sc.ops, []);
  assert.deepEqual(sc.outputs, [{ format: 'mp4', codec: 'h264/aac' }]);
  // poster defaults to min(1000, durationMs/2) per spec §1.2
  assert.equal(sc.poster.timeMs, 1000);
  assert.equal(sc.source.kind, 'upload');
  assert.equal(sc.source.storedHash, HEX64);
  assert.equal(sc.source.uploadFormat, 'mov');
  assert.equal(sc.source.uploadWidth, 640);
  assert.equal(sc.source.uploadHeight, 480);
  assert.equal(sc.source.durationMs, 10000);
  assert.deepEqual(sc.source.probe, { codecVideo: 'h264', codecAudio: 'aac' });
});

test('makeDefaultVideoSidecar accepts explicit posterTimeMs and fetchedAt', () => {
  const sc = makeDefaultVideoSidecar(HEX64, {
    source: { kind: 'url', originalName: 'clip.mp4', fetchedAt: '2026-08-28T00:00:00Z' },
    probe: {
      width: 1920,
      height: 1080,
      durationMs: 1200,
      codecVideo: 'avc1',
      codecAudio: null,
      format: 'mp4'
    },
    bytes: 5,
    storedHash: HEX64,
    posterTimeMs: 300
  });
  assert.equal(sc.poster.timeMs, 300);
  assert.equal(sc.source.fetchedAt, '2026-08-28T00:00:00Z');
  assert.equal(sc.source.probe.codecAudio, null);
});

test('writeVideoSidecar is atomic: no .tmp files remain', async (t) => {
  const root = freshSiteRoot(t);
  await writeVideoSidecar(root, HEX64, validSidecar());
  const files = fs.readdirSync(path.join(root, 'sidecars', 'videos'));
  assert.deepEqual(files, [`${HEX64}.json`], 'no .tmp file should remain');
});
