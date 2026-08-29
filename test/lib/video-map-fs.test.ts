import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { buildVideoMap, type VideoSource, videoDimensions } from '../../src/lib/video-map-fs.ts';
import { videoCachePaths } from '../../src/lib/video-render.ts';
import {
  CURRENT_VIDEO_SIDE_VERSION,
  type VideoOp,
  type VideoSidecar,
  writeVideoSidecar
} from '../../src/lib/video-sidecar.ts';

const HEX64 = 'a'.repeat(64);

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-vmap-'));
  fs.mkdirSync(path.join(root, 'sidecars', 'videos'), { recursive: true });
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

test('buildVideoMap reads sidecars/videos and exposes dimensions + urlFor', async (t) => {
  const root = freshSiteRoot(t);
  await writeVideoSidecar(root, HEX64, validSidecar());
  await writeVideoSidecar(root, 'd'.repeat(64), validSidecar({ original: 'd'.repeat(64) }));

  const map = await buildVideoMap(root);
  assert.equal(map.size, 2);
  const src: VideoSource | undefined = map.get(HEX64);
  assert.ok(src);
  assert.equal(src.width, 640);
  assert.equal(src.height, 480);
  assert.equal(src.durationMs, 10000);
  assert.equal(src.sidecar.original, HEX64);
  assert.deepEqual(videoDimensions(src.sidecar), { width: 640, height: 480 });

  const urls = await src.urlFor([], 1000);
  assert.match(urls.videoUrl, new RegExp(`^/video/${HEX64}\\.[0-9a-f]{12}\\.mp4$`));
  assert.match(urls.posterUrl, new RegExp(`^/video/poster/${HEX64}\\.[0-9a-f]{12}\\.jpg$`));
});

test('buildVideoMap returns an empty map when sidecars/videos is absent', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-vmap-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal((await buildVideoMap(root)).size, 0);
});

test('buildVideoMap propagates non-ENOENT readdir failures', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-vmap-enotdir-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // sidecars/videos exists as a regular file -> readdir throws ENOTDIR.
  fs.mkdirSync(path.join(root, 'sidecars'));
  fs.writeFileSync(path.join(root, 'sidecars', 'videos'), 'not a dir');
  await assert.rejects(buildVideoMap(root), (err: unknown) => {
    assert.equal((err as NodeJS.ErrnoException).code, 'ENOTDIR');
    return true;
  });
});

test('buildVideoMap urlFor reflects ops in the ophash', async (t) => {
  const root = freshSiteRoot(t);
  await writeVideoSidecar(root, HEX64, validSidecar());
  const src = (await buildVideoMap(root)).get(HEX64);
  assert.ok(src);

  const plain = await src.urlFor([], 1000);
  const trimmed = await src.urlFor([{ kind: 'trim', startMs: 0, endMs: 5000 }], 1000);
  assert.notEqual(trimmed.videoUrl, plain.videoUrl);
  assert.notEqual(trimmed.posterUrl, plain.posterUrl);
});

test('buildVideoMap urlFor hashes match the render cache filenames', async (t) => {
  const root = freshSiteRoot(t);
  await writeVideoSidecar(root, HEX64, validSidecar());
  const src = (await buildVideoMap(root)).get(HEX64);
  assert.ok(src);

  const ops: VideoOp[] = [{ kind: 'trim', startMs: 0, endMs: 5000 }];
  const urls = await src.urlFor(ops, 1234);
  const cachePaths = videoCachePaths(root, HEX64, ops, 1234);
  assert.equal(urls.videoUrl, `/video/${path.basename(cachePaths.videoPath)}`);
  assert.equal(urls.posterUrl, `/video/poster/${path.basename(cachePaths.posterPath)}`);
});

test('buildVideoMap skips sidecar files that do not parse to a sidecar', async (t) => {
  const root = freshSiteRoot(t);
  await writeVideoSidecar(root, HEX64, validSidecar());
  // JSON.parse("null") -> null: readVideoSidecar returns null for this id.
  fs.writeFileSync(path.join(root, 'sidecars', 'videos', `${'e'.repeat(64)}.json`), 'null\n');

  const map = await buildVideoMap(root);
  assert.equal(map.size, 1);
  assert.ok(map.has(HEX64));
  assert.equal(map.has('e'.repeat(64)), false);
});
