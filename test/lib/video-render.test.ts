import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import {
  renderVideoDerivative,
  videoCachePaths,
  videoFilename
} from '../../src/lib/video-render.ts';
import {
  CURRENT_VIDEO_SIDE_VERSION,
  type VideoOp,
  type VideoSidecar,
  writeVideoSidecar
} from '../../src/lib/video-sidecar.ts';

const HEX64 = 'a'.repeat(64);

/** Fresh temp site root with the video trees, removed after the test. */
function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-vrender-'));
  for (const sub of ['originals/videos', 'sidecars/videos', 'cache/video']) {
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
async function seedVideo(root: string, id: string): Promise<string> {
  const dir = path.join(root, 'originals', 'videos', id.slice(0, 2), id.slice(2, 4));
  fs.mkdirSync(dir, { recursive: true });
  const originalPath = path.join(dir, `${id}.mp4`);
  fs.writeFileSync(originalPath, Buffer.from('fake-original-video'));
  await writeVideoSidecar(root, id, validSidecar());
  return originalPath;
}

// ---- fake ffmpeg on PATH ------------------------------------------------

function freshBinDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-vren-bin-'));
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

function recordArgsTo(t: TestContext, dir: string): string {
  const argsFile = path.join(dir, 'args.txt');
  process.env.RKR_ARGS_FILE = argsFile;
  t.after(() => {
    delete process.env.RKR_ARGS_FILE;
  });
  return argsFile;
}

function recordCountTo(t: TestContext, dir: string): string {
  const countFile = path.join(dir, 'count.txt');
  process.env.RKR_COUNT_FILE = countFile;
  t.after(() => {
    delete process.env.RKR_COUNT_FILE;
  });
  return countFile;
}

/**
 * Fake ffmpeg: records each invocation's argv as a `===` block in
 * RKR_ARGS_FILE, appends a line to RKR_COUNT_FILE, runs `extra` shell (e.g.
 * "sleep 0.5" to hold the transcode open), then writes fake bytes to its last
 * arg (the output path).
 */
function writeFakeFfmpeg(dir: string, extra = ''): void {
  fs.writeFileSync(
    path.join(dir, 'ffmpeg'),
    [
      '#!/bin/sh',
      '[ -n "$RKR_ARGS_FILE" ] && {',
      '  printf \'=== %s\\n\' "$#" >> "$RKR_ARGS_FILE"',
      '  printf \'%s\\n\' "$@" >> "$RKR_ARGS_FILE"',
      '}',
      '[ -n "$RKR_COUNT_FILE" ] && printf \'x\\n\' >> "$RKR_COUNT_FILE"',
      extra,
      'for last do :; done',
      'printf \'fake-video\' > "$last"',
      'exit 0'
    ].join('\n'),
    { mode: 0o755 }
  );
}

function writeFailingFfmpeg(dir: string): void {
  fs.writeFileSync(path.join(dir, 'ffmpeg'), '#!/bin/sh\necho "boom" >&2\nexit 1\n', {
    mode: 0o755
  });
}

/** Parse the args file into one string[] per ffmpeg invocation. */
function readInvocations(argsFile: string): string[][] {
  const lines = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
  const invocations: string[][] = [];
  for (const line of lines) {
    if (line.startsWith('===')) invocations.push([]);
    else invocations[invocations.length - 1]?.push(line);
  }
  return invocations;
}

function countLines(file: string): number {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length;
  } catch {
    return 0; // file not created yet
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---- hash stability -----------------------------------------------------

test('videoCachePaths: ophashes are stable; trim changes them; poster time is not part of the key', () => {
  const p1 = videoCachePaths('/site', HEX64, [], 1000);
  const p2 = videoCachePaths('/site', HEX64, [], 5000);
  assert.equal(p1.videoOphash, p2.videoOphash);
  assert.equal(p1.posterOphash, p2.posterOphash);
  assert.match(p1.videoOphash, /^[0-9a-f]{12}$/);
  assert.match(p1.posterOphash, /^[0-9a-f]{12}$/);
  assert.match(p1.videoPath, new RegExp(`^/site/cache/video/${HEX64}\\.[0-9a-f]{12}\\.mp4$`));
  assert.match(p1.posterPath, new RegExp(`^/site/cache/video/${HEX64}\\.[0-9a-f]{12}\\.jpg$`));

  const trimmed: VideoOp[] = [{ kind: 'trim', startMs: 0, endMs: 1000 }];
  const p3 = videoCachePaths('/site', HEX64, trimmed, 1000);
  assert.notEqual(p3.videoOphash, p1.videoOphash);
  assert.notEqual(p3.posterOphash, p1.posterOphash);
});

test('videoFilename names cache files <id>.<oph>.<ext>', () => {
  const p = videoCachePaths('/site', HEX64, [], 1000);
  assert.equal(videoFilename(HEX64, [], false), `${HEX64}.${p.videoOphash}.mp4`);
  assert.equal(videoFilename(HEX64, [], true), `${HEX64}.${p.posterOphash}.jpg`);
});

// ---- render flow --------------------------------------------------------

test('renderVideoDerivative transcodes + extracts a poster, then serves from cache', async (t) => {
  const root = freshSiteRoot(t);
  const originalPath = await seedVideo(root, HEX64);
  const binDir = freshBinDir(t);
  writeFakeFfmpeg(binDir);
  prependPath(t, binDir);
  const argsFile = recordArgsTo(t, binDir);

  const r1 = await renderVideoDerivative({
    originalId: HEX64,
    ops: [],
    posterTimeMs: 1000,
    siteRoot: root
  });
  assert.equal(r1.cached, false);
  assert.ok(fs.existsSync(r1.videoPath));
  assert.ok(fs.existsSync(r1.posterPath));
  assert.equal(r1.bytes, fs.statSync(r1.videoPath).size);

  const invocations = readInvocations(argsFile);
  assert.equal(invocations.length, 2, 'one transcode + one poster extraction');

  const transcodeArgs = invocations[0] ?? [];
  assert.equal(transcodeArgs[transcodeArgs.indexOf('-i') + 1], originalPath);
  assert.ok(transcodeArgs.includes('-movflags'));
  assert.ok(transcodeArgs.includes('+faststart'));
  assert.match(transcodeArgs[transcodeArgs.length - 1] ?? '', /\.tmp$/);

  const posterArgs = invocations[1] ?? [];
  assert.equal(posterArgs[posterArgs.indexOf('-ss') + 1], '1');
  assert.ok(posterArgs.includes('-vframes'));
  assert.ok(posterArgs.includes('1'));

  const cacheDir = path.join(root, 'cache', 'video');
  assert.equal(
    fs.readdirSync(cacheDir).filter((f) => f.endsWith('.tmp')).length,
    0,
    'no tmp files remain after a successful render'
  );

  // Second call: both files exist -> cached, no ffmpeg run.
  const r2 = await renderVideoDerivative({
    originalId: HEX64,
    ops: [],
    posterTimeMs: 1000,
    siteRoot: root
  });
  assert.equal(r2.cached, true);
  assert.equal(r2.videoPath, r1.videoPath);
  assert.equal(r2.posterPath, r1.posterPath);
  assert.equal(readInvocations(argsFile).length, 2, 'cache hit does not re-run ffmpeg');
});

test('renderVideoDerivative clamps posterTimeMs into [startMs, endMs)', async (t) => {
  const root = freshSiteRoot(t);
  await seedVideo(root, HEX64);
  const binDir = freshBinDir(t);
  writeFakeFfmpeg(binDir);
  prependPath(t, binDir);
  const argsFile = recordArgsTo(t, binDir);

  const trim: VideoOp[] = [{ kind: 'trim', startMs: 2000, endMs: 4550 }];

  // Above end -> 4549ms (endMs exclusive); below start -> 2000ms.
  await renderVideoDerivative({
    originalId: HEX64,
    ops: trim,
    posterTimeMs: 5000,
    siteRoot: root
  });
  let invocations = readInvocations(argsFile);
  let posterArgs = invocations[1] ?? [];
  assert.equal(posterArgs[posterArgs.indexOf('-ss') + 1], '4.549');

  await renderVideoDerivative({
    originalId: HEX64,
    ops: trim,
    posterTimeMs: 500,
    siteRoot: root,
    force: true
  });
  invocations = readInvocations(argsFile);
  posterArgs = invocations[3] ?? [];
  assert.equal(posterArgs[posterArgs.indexOf('-ss') + 1], '2');

  // NaN falls back to the window start.
  await renderVideoDerivative({
    originalId: HEX64,
    ops: trim,
    posterTimeMs: Number.NaN,
    siteRoot: root,
    force: true
  });
  invocations = readInvocations(argsFile);
  posterArgs = invocations[5] ?? [];
  assert.equal(posterArgs[posterArgs.indexOf('-ss') + 1], '2');
});

test('renderVideoDerivative clamps to the sidecar duration when untrimmed and unknown sidecars to 0', async (t) => {
  const root = freshSiteRoot(t);
  await seedVideo(root, HEX64); // durationMs 10000
  const binDir = freshBinDir(t);
  writeFakeFfmpeg(binDir);
  prependPath(t, binDir);
  const argsFile = recordArgsTo(t, binDir);

  await renderVideoDerivative({
    originalId: HEX64,
    ops: [],
    posterTimeMs: 50000,
    siteRoot: root
  });
  let invocations = readInvocations(argsFile);
  let posterArgs = invocations[1] ?? [];
  assert.equal(posterArgs[posterArgs.indexOf('-ss') + 1], '9.999');

  // No sidecar: duration unknown, poster lands at 0.
  const bareId = 'b'.repeat(64);
  const dir = path.join(root, 'originals', 'videos', 'bb', 'bb');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${bareId}.mp4`), Buffer.from('bare'));
  await renderVideoDerivative({
    originalId: bareId,
    ops: [],
    posterTimeMs: 1000,
    siteRoot: root
  });
  invocations = readInvocations(argsFile);
  posterArgs = invocations[3] ?? [];
  assert.equal(posterArgs[posterArgs.indexOf('-ss') + 1], '0');
});

test('renderVideoDerivative throws when the original is missing', async (t) => {
  const root = freshSiteRoot(t);
  const binDir = freshBinDir(t);
  writeFakeFfmpeg(binDir);
  prependPath(t, binDir);
  await assert.rejects(
    renderVideoDerivative({
      originalId: 'c'.repeat(64),
      ops: [],
      posterTimeMs: 1000,
      siteRoot: root
    }),
    /no original/
  );
});

test('renderVideoDerivative cleans up tmp files and rejects when ffmpeg fails', async (t) => {
  const root = freshSiteRoot(t);
  await seedVideo(root, HEX64);
  const binDir = freshBinDir(t);
  writeFailingFfmpeg(binDir);
  prependPath(t, binDir);

  await assert.rejects(
    renderVideoDerivative({
      originalId: HEX64,
      ops: [],
      posterTimeMs: 1000,
      siteRoot: root
    }),
    /exited with code 1/
  );
  assert.deepEqual(
    fs.readdirSync(path.join(root, 'cache', 'video')),
    [],
    'no tmp files remain after a failed render'
  );
});

test('renderVideoDerivative dedups concurrent renders of the same derivative', async (t) => {
  const root = freshSiteRoot(t);
  await seedVideo(root, HEX64);
  const binDir = freshBinDir(t);
  writeFakeFfmpeg(binDir, 'sleep 0.5'); // hold the transcode open
  prependPath(t, binDir);
  const countFile = recordCountTo(t, binDir);

  const r1Promise = renderVideoDerivative({
    originalId: HEX64,
    ops: [],
    posterTimeMs: 1000,
    siteRoot: root
  });
  await waitFor(() => countLines(countFile) === 1); // transcode is in flight

  const r2 = await renderVideoDerivative({
    originalId: HEX64,
    ops: [],
    posterTimeMs: 1000,
    siteRoot: root
  });
  const r1 = await r1Promise;

  assert.equal(r1.cached, false);
  assert.equal(r2.cached, false, 'second caller missed cache and rode the in-flight render');
  assert.equal(r2.videoPath, r1.videoPath);
  // One transcode + one poster for BOTH callers; without dedup this would be 4.
  assert.equal(countLines(countFile), 2, 'ffmpeg ran once per derivative for both callers');
});

test('renderVideoDerivative force re-renders even when cached', async (t) => {
  const root = freshSiteRoot(t);
  await seedVideo(root, HEX64);
  const binDir = freshBinDir(t);
  writeFakeFfmpeg(binDir);
  prependPath(t, binDir);
  const countFile = recordCountTo(t, binDir);

  const r1 = await renderVideoDerivative({
    originalId: HEX64,
    ops: [],
    posterTimeMs: 1000,
    siteRoot: root
  });
  const r2 = await renderVideoDerivative({
    originalId: HEX64,
    ops: [],
    posterTimeMs: 1000,
    siteRoot: root
  });
  const r3 = await renderVideoDerivative({
    originalId: HEX64,
    ops: [],
    posterTimeMs: 1000,
    siteRoot: root,
    force: true
  });

  assert.equal(r1.cached, false);
  assert.equal(r2.cached, true);
  assert.equal(r3.cached, false);
  assert.equal(
    countLines(countFile),
    4,
    'force skips the cache fast path (2 invocations per render)'
  );
});
