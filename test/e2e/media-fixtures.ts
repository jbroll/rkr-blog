// Generated media for e2e uploads: small, distinct files so content-
// addressed ids never collide between tests.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

/** Generate a tiny 2s 160x120 h264/aac mp4 via ffmpeg. The mp4 muxer
 * refuses non-seekable (pipe) output, so write to a temp file. */
export function makeFixtureMp4(): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-video-fixture-'));
  const out = path.join(dir, 'clip.mp4');
  try {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=160x120:rate=15',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        out
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    );
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A solid-colour PNG; vary `seed` for a distinct id. */
export function makePng(seed: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 240,
      height: 160,
      channels: 3,
      background: { r: (seed * 53) % 256, g: (seed * 97) % 256, b: (seed * 151) % 256 }
    }
  })
    .png()
    .toBuffer();
}
