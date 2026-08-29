import assert from 'node:assert/strict';
import { test } from 'node:test';

import probeVideoCli from '../../src/cli/video.ts';
import type { VideoProbe } from '../../src/lib/video-ffmpeg.ts';

// `site-admin video probe <path>` — operator helper that prints the
// ffprobe result JSON for a file, so an operator can see whether an
// upload would be accepted before ingesting it. The probe is injected so
// the CLI logic is testable without ffmpeg on the unit-test runner.

function captureLog(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (msg: string) => {
    lines.push(msg);
  };
  return fn()
    .finally(() => {
      console.log = orig;
    })
    .then(() => lines.join('\n'));
}

test('video probe prints the probe JSON for a path', async () => {
  const probe: (filePath: string) => Promise<VideoProbe> = async () => ({
    width: 160,
    height: 120,
    durationMs: 2000,
    codecVideo: 'h264',
    codecAudio: 'aac',
    format: 'mp4'
  });
  const out = await captureLog(() => probeVideoCli(['probe', '/tmp/clip.mp4'], probe));
  assert.match(out, /"width": 160/);
  assert.match(out, /"codecVideo": "h264"/);
  assert.match(out, /"durationMs": 2000/);
});

test('video probe rejects a missing path', async () => {
  await assert.rejects(
    () =>
      probeVideoCli(['probe'], async () => {
        throw new Error('unused');
      }),
    /usage: site-admin video probe/
  );
});

test('video probe rejects an unknown subcommand', async () => {
  await assert.rejects(
    () =>
      probeVideoCli(['gc'], async () => {
        throw new Error('unused');
      }),
    /usage: site-admin video probe/
  );
});
