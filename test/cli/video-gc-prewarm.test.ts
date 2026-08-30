import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { runGc } from '../../src/cli/gc.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { videoFilename } from '../../src/lib/video-render.ts';
import {
  CURRENT_VIDEO_SIDE_VERSION,
  type VideoSidecar,
  writeVideoSidecar
} from '../../src/lib/video-sidecar.ts';
import { prewarmVariants } from '../../src/routes/admin-prewarm.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-video-gc-'));
  for (const sub of [
    'sidecars/videos',
    'originals/videos',
    'cache/video',
    'content/posts',
    'data'
  ]) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function writeVideoFixture(root: string, id: string): Promise<void> {
  const dir = path.join(root, 'originals', 'videos', id.slice(0, 2), id.slice(2, 4));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.mp4`), Buffer.from('fake-video'));
  await writeVideoSidecar(root, id, {
    version: CURRENT_VIDEO_SIDE_VERSION,
    original: id,
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
    poster: { timeMs: 1000 }
  } satisfies VideoSidecar);
}

test('runGc deletes orphan video cache entries and preserves valid derivatives', async (t) => {
  const root = freshSiteRoot(t);
  const id = 'a'.repeat(64);
  await writeVideoFixture(root, id);

  // Valid cache files for this sidecar.
  const validVideo = videoFilename(id, [], false);
  const validPoster = videoFilename(id, [], true, 1000);
  const cacheVideoDir = path.join(root, 'cache', 'video');
  fs.writeFileSync(path.join(cacheVideoDir, validVideo), Buffer.alloc(8));
  fs.writeFileSync(path.join(cacheVideoDir, validPoster), Buffer.alloc(8));
  // Orphan file not in valid set.
  const orphan = `${id}.deadbeef1234.mp4`;
  fs.writeFileSync(path.join(cacheVideoDir, orphan), Buffer.alloc(8));

  // Need a post referencing the video so sidecar/original aren't considered orphaned.
  fs.writeFileSync(
    path.join(root, 'content', 'posts', 'hello.md'),
    `---\nslug: hello\n---\n::video{id=${id}}\n`
  );

  const result = await runGc(root, { tmpMinAgeMs: 0 });
  assert.ok(result.deleted >= 1, 'orphan deleted');
  assert.equal(fs.existsSync(path.join(cacheVideoDir, orphan)), false);
  assert.equal(fs.existsSync(path.join(cacheVideoDir, validVideo)), true);
  assert.equal(fs.existsSync(path.join(cacheVideoDir, validPoster)), true);
});

test('runGc deletes orphaned video sidecars and originals when no post references them', async (t) => {
  const root = freshSiteRoot(t);
  const orphanId = 'b'.repeat(64);
  await writeVideoFixture(root, orphanId);

  // No posts reference orphanId — GC should delete sidecar + original.
  const result = await runGc(root, { tmpMinAgeMs: 0 });
  assert.ok(result.deleted >= 2, 'sidecar + original deleted');
  assert.equal(fs.existsSync(path.join(root, 'sidecars', 'videos', `${orphanId}.json`)), false);
  const origPath = path.join(
    root,
    'originals',
    'videos',
    orphanId.slice(0, 2),
    orphanId.slice(2, 4),
    `${orphanId}.mp4`
  );
  assert.equal(fs.existsSync(origPath), false);
});

test('runGc sweeps stale .tmp under cache/video and sidecars/videos and originals/videos/.tmp', async (t) => {
  const root = freshSiteRoot(t);
  const cacheVideoDir = path.join(root, 'cache', 'video');
  fs.writeFileSync(path.join(cacheVideoDir, 'stale.tmp'), Buffer.alloc(0));
  const sidecarVideoDir = path.join(root, 'sidecars', 'videos');
  fs.writeFileSync(path.join(sidecarVideoDir, 'crash.json.tmp'), Buffer.alloc(0));
  const origVideoTmp = path.join(root, 'originals', 'videos', '.tmp');
  fs.mkdirSync(origVideoTmp, { recursive: true });
  fs.writeFileSync(path.join(origVideoTmp, 'ingest-deadbeef.bin'), Buffer.alloc(4));

  const result = await runGc(root, { tmpMinAgeMs: 0 });
  assert.ok(result.deleted >= 3);
  assert.equal(fs.existsSync(path.join(cacheVideoDir, 'stale.tmp')), false);
  assert.equal(fs.existsSync(path.join(sidecarVideoDir, 'crash.json.tmp')), false);
  assert.equal(fs.existsSync(path.join(origVideoTmp, 'ingest-deadbeef.bin')), false);
});

test('prewarmVariants enqueues a renderVideo job for referenced videos', async (t) => {
  const root = freshSiteRoot(t);
  const id = 'c'.repeat(64);
  await writeVideoFixture(root, id);
  const db = open(':memory:');
  migrate(db);
  t.after(() => db.close());

  const markdown = `::video{id=${id}}`;
  await prewarmVariants(db, root, markdown);

  const row = db
    .prepare<{ kind: string; payload: string }>('SELECT kind, payload FROM jobs LIMIT 1')
    .get();
  assert.ok(row, 'job enqueued');
  assert.equal(row.kind, 'renderVideo');
  const payload = JSON.parse(row.payload) as { originalId: string };
  assert.equal(payload.originalId, id);
});
