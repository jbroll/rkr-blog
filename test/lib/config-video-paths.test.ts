import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import {
  DEFAULT_VIDEO_CAPS,
  paths,
  readPersistedSiteConfig,
  resolveVideoCaps,
  siteConfig,
  VIDEO_CAPS_BOUNDS,
  writePersistedSiteConfig
} from '../../src/lib/config.ts';

function freshRoot(t: TestContext): { root: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-vcfg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, env: { SITE_ROOT: root } };
}

test('video paths derive from site root', () => {
  const p = paths({ SITE_ROOT: '/tmp/site' });
  assert.equal(p.originalsVideo, '/tmp/site/originals/videos');
  assert.equal(p.sidecarsVideo, '/tmp/site/sidecars/videos');
  assert.equal(p.cacheVideo, '/tmp/site/cache/video');
});

test('video caps defaults + bounds match the v1 contract', () => {
  assert.deepEqual(DEFAULT_VIDEO_CAPS, {
    maxBytes: 500 * 1024 * 1024,
    maxDurationMs: 300_000,
    maxWidth: 1920
  });
  assert.equal(VIDEO_CAPS_BOUNDS.maxBytes.max, 2 * 1024 * 1024 * 1024);
  assert.equal(VIDEO_CAPS_BOUNDS.maxDurationMs.max, 600_000);
  assert.equal(VIDEO_CAPS_BOUNDS.maxWidth.max, 7680);
});

test('videoCaps round-trips through persisted config, clamped to bounds', (t) => {
  const { env } = freshRoot(t);
  writePersistedSiteConfig(
    { videoCaps: { maxBytes: 999_999_999_999, maxDurationMs: 50, maxWidth: 1920 } },
    env
  );
  const p = readPersistedSiteConfig(env);
  assert.equal(p.videoCaps?.maxBytes, VIDEO_CAPS_BOUNDS.maxBytes.max);
  assert.equal(p.videoCaps?.maxDurationMs, VIDEO_CAPS_BOUNDS.maxDurationMs.min);
  assert.equal(p.videoCaps?.maxWidth, 1920);
  assert.equal(siteConfig(env).videoCaps?.maxWidth, 1920);
});

test('videoCaps: non-numeric fields are dropped; all-dropped caps vanish', (t) => {
  const { root, env } = freshRoot(t);
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'config', 'site.json'),
    JSON.stringify({ videoCaps: { maxBytes: 'huge', maxDurationMs: 300_000, maxWidth: {} } })
  );
  assert.deepEqual(readPersistedSiteConfig(env).videoCaps, { maxDurationMs: 300_000 });
  fs.writeFileSync(
    path.join(root, 'config', 'site.json'),
    JSON.stringify({ videoCaps: { maxWidth: {} } })
  );
  assert.equal(readPersistedSiteConfig(env).videoCaps, undefined);
});

test('writePersistedSiteConfig: videoCaps merges per-field like ingestResize', (t) => {
  const { env } = freshRoot(t);
  writePersistedSiteConfig({ videoCaps: { maxBytes: 64 * 1024 * 1024 } }, env);
  writePersistedSiteConfig({ title: 'Second' }, env);
  const p = readPersistedSiteConfig(env);
  assert.equal(p.title, 'Second');
  assert.equal(p.videoCaps?.maxBytes, 64 * 1024 * 1024);
});

test('resolveVideoCaps: defaults when nothing persisted', (t) => {
  const { root } = freshRoot(t);
  assert.deepEqual(resolveVideoCaps(root), DEFAULT_VIDEO_CAPS);
});

test('resolveVideoCaps: persisted overrides merge over defaults', (t) => {
  const { root, env } = freshRoot(t);
  writePersistedSiteConfig({ videoCaps: { maxBytes: 64 * 1024 * 1024 } }, env);
  assert.deepEqual(resolveVideoCaps(root), {
    maxBytes: 64 * 1024 * 1024,
    maxDurationMs: 300_000,
    maxWidth: 1920
  });
});
