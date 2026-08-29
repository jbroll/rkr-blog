import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import {
  buildFfmpegArgs,
  buildPosterArgs,
  parseProbeJson,
  probeVideo,
  runFfmpeg
} from '../../src/lib/video-ffmpeg.ts';

const PROBE_FIXTURE = {
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      duration: '12.5'
    },
    { index: 1, codec_type: 'audio', codec_name: 'aac', duration: '12.5' }
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.5' }
};

/** Fresh temp dir used as a PATH entry holding fake ffmpeg/ffprobe executables. */
function freshBinDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-vff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFakeBin(dir: string, name: string, script: string): void {
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

function prependPath(t: TestContext, dir: string): void {
  const prev = process.env.PATH;
  process.env.PATH = prev ? `${dir}:${prev}` : dir;
  t.after(() => {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
  });
}

/** Replace PATH entirely so a binary can be provably absent. */
function isolatePath(t: TestContext, dir: string): void {
  const prev = process.env.PATH;
  process.env.PATH = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
  });
}

/** Point RKR_ARGS_FILE at a file the fake binaries write their argv into. */
function recordArgsTo(t: TestContext, dir: string): string {
  const argsFile = path.join(dir, 'args.txt');
  process.env.RKR_ARGS_FILE = argsFile;
  t.after(() => {
    delete process.env.RKR_ARGS_FILE;
  });
  return argsFile;
}

test('buildFfmpegArgs builds the full trim+scale mp4 arg list', () => {
  const args = buildFfmpegArgs({
    input: '/tmp/in.mp4',
    output: '/tmp/out.mp4',
    startMs: 2000,
    endMs: 45500,
    maxWidth: 1920
  });
  assert.deepEqual(args, [
    '-ss',
    '2',
    '-to',
    '45.5',
    '-i',
    '/tmp/in.mp4',
    '-vf',
    "scale='min(1920,iw)':-2:flags=lanczos",
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    // Explicit muxer: the render writes to a .tmp path, so ffmpeg can't
    // infer the format from the output extension (e2e regression).
    '-f',
    'mp4',
    '/tmp/out.mp4'
  ]);
});

test('buildFfmpegArgs omits -ss/-to when no trim is given', () => {
  const args = buildFfmpegArgs({ input: 'in.mp4', output: 'out.mp4' });
  assert.ok(!args.includes('-ss'));
  assert.ok(!args.includes('-to'));
  assert.equal(args[0], '-i');
});

test('buildFfmpegArgs scales to a custom maxWidth', () => {
  const args = buildFfmpegArgs({ input: 'in.mp4', output: 'out.mp4', maxWidth: 1280 });
  assert.ok(args.join(' ').includes("scale='min(1280,iw)':-2:flags=lanczos"));
});

test('buildPosterArgs extracts a single frame at the given time', () => {
  assert.deepEqual(buildPosterArgs({ input: 'in.mp4', timeMs: 2500, output: 'poster.jpg' }), [
    '-ss',
    '2.5',
    '-i',
    'in.mp4',
    '-vframes',
    '1',
    '-q:v',
    '2',
    '-f',
    'mjpeg',
    'poster.jpg'
  ]);
});

test('parseProbeJson maps streams and format fields', () => {
  assert.deepEqual(parseProbeJson(PROBE_FIXTURE), {
    width: 1920,
    height: 1080,
    durationMs: 12500,
    codecVideo: 'h264',
    codecAudio: 'aac',
    format: 'mov,mp4,m4a,3gp,3g2,mj2'
  });
});

test('parseProbeJson: no audio stream yields codecAudio null', () => {
  const fixture = {
    streams: [{ index: 0, codec_type: 'video', codec_name: 'avc1', width: 640, height: 480 }],
    format: { format_name: 'webm' }
  };
  assert.deepEqual(parseProbeJson(fixture), {
    width: 640,
    height: 480,
    durationMs: 0,
    codecVideo: 'avc1',
    codecAudio: null,
    format: 'webm'
  });
});

test('parseProbeJson falls back to format duration and ignores N/A', () => {
  const fixture = {
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'h264',
        width: 640,
        height: 480,
        duration: 'N/A'
      }
    ],
    format: { format_name: 'matroska,webm', duration: '3.25' }
  };
  assert.deepEqual(parseProbeJson(fixture), {
    width: 640,
    height: 480,
    durationMs: 3250,
    codecVideo: 'h264',
    codecAudio: null,
    format: 'matroska,webm'
  });
});

test('parseProbeJson throws when no video stream exists', () => {
  assert.throws(
    () => parseProbeJson({ streams: [{ codec_type: 'audio' }], format: {} }),
    /no video stream/
  );
});

test('runFfmpeg spawns ffmpeg with the exact buildFfmpegArgs output', async (t) => {
  const dir = freshBinDir(t);
  writeFakeBin(dir, 'ffmpeg', `printf '%s\\n' "$@" > "$RKR_ARGS_FILE"; exit 0`);
  prependPath(t, dir);
  const argsFile = recordArgsTo(t, dir);

  const args = buildFfmpegArgs({
    input: '/tmp/in.mp4',
    output: '/tmp/out.mp4',
    startMs: 2000,
    endMs: 45500,
    maxWidth: 1920
  });
  await runFfmpeg(args, { timeoutMs: 5000 });
  assert.deepEqual(fs.readFileSync(argsFile, 'utf8').trim().split('\n'), args);
});

test('runFfmpeg rejects with the stderr tail on non-zero exit', async (t) => {
  const dir = freshBinDir(t);
  writeFakeBin(dir, 'ffmpeg', 'echo "broken pipe" >&2; exit 1');
  prependPath(t, dir);
  await assert.rejects(
    runFfmpeg(['-i', 'x'], { timeoutMs: 5000 }),
    /exited with code 1: broken pipe/
  );
});

test('runFfmpeg rejects with an actionable message when ffmpeg is missing', async (t) => {
  const dir = freshBinDir(t);
  isolatePath(t, dir); // empty PATH: ffmpeg is provably absent
  await assert.rejects(
    runFfmpeg(['-i', 'x'], { timeoutMs: 5000 }),
    /ffmpeg not found; install ffmpeg package/
  );
});

test('runFfmpeg kills the child and rejects on timeout', async (t) => {
  const dir = freshBinDir(t);
  writeFakeBin(dir, 'ffmpeg', 'sleep 30');
  prependPath(t, dir);
  await assert.rejects(runFfmpeg(['-i', 'x'], { timeoutMs: 200 }), /timed out after 200ms/);
});

test('probeVideo spawns ffprobe and parses the json result', async (t) => {
  const dir = freshBinDir(t);
  writeFakeBin(
    dir,
    'ffprobe',
    `printf '%s\\n' "$@" > "$RKR_ARGS_FILE"; cat <<'EOF'\n${JSON.stringify(PROBE_FIXTURE)}\nEOF`
  );
  prependPath(t, dir);
  const argsFile = recordArgsTo(t, dir);

  const probe = await probeVideo('/tmp/clip.mp4');
  assert.deepEqual(probe, {
    width: 1920,
    height: 1080,
    durationMs: 12500,
    codecVideo: 'h264',
    codecAudio: 'aac',
    format: 'mov,mp4,m4a,3gp,3g2,mj2'
  });
  assert.deepEqual(fs.readFileSync(argsFile, 'utf8').trim().split('\n'), [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    '/tmp/clip.mp4'
  ]);
});

test('probeVideo rejects with the stderr tail on ffprobe failure', async (t) => {
  const dir = freshBinDir(t);
  writeFakeBin(dir, 'ffprobe', 'echo "Invalid data found" >&2; exit 1');
  prependPath(t, dir);
  await assert.rejects(probeVideo('/tmp/clip.mp4'), /exited with code 1: Invalid data found/);
});

test('probeVideo rejects with an actionable message when ffprobe is missing', async (t) => {
  const dir = freshBinDir(t);
  isolatePath(t, dir);
  await assert.rejects(probeVideo('/tmp/clip.mp4'), /ffprobe not found; install ffmpeg package/);
});

test('probeVideo rejects when ffprobe returns invalid json', async (t) => {
  const dir = freshBinDir(t);
  writeFakeBin(dir, 'ffprobe', 'printf "not json"');
  prependPath(t, dir);
  await assert.rejects(probeVideo('/tmp/clip.mp4'), SyntaxError);
});
