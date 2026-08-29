// Unit tests for the ::video widget (video spec §5). Covers attribute
// parsing (trim, poster, booleans), rendering shape (figure shell,
// aspect-reserving wrapper, video element), and degenerate cases
// (invalid attrs, unknown id, trim beyond duration).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { buildVideoMap, type VideoMap } from '../../src/lib/video-map-fs.ts';
import {
  CURRENT_VIDEO_SIDE_VERSION,
  type VideoSidecar,
  writeVideoSidecar
} from '../../src/lib/video-sidecar.ts';
import { type DirectiveNode, WidgetRegistry } from '../../src/lib/widgets.ts';
import videoWidget from '../../src/widgets/video.ts';
import {
  parsePoster,
  parseTrim,
  parseVideoWidth,
  validateVideoAttrs
} from '../../src/widgets/video-attrs.ts';

const HEX64 = 'a'.repeat(64);
const DURATION_MS = 60_000;

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-video-widget-'));
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
      durationMs: DURATION_MS,
      probe: { codecVideo: 'h264', codecAudio: 'aac' }
    },
    ops: [],
    outputs: [{ format: 'mp4', codec: 'h264/aac' }],
    poster: { timeMs: 1000 },
    ...overrides
  };
}

async function mapWith(t: TestContext, ...sidecars: VideoSidecar[]): Promise<VideoMap> {
  const root = freshSiteRoot(t);
  for (const sc of sidecars) await writeVideoSidecar(root, sc.original, sc);
  return buildVideoMap(root);
}

function node(attrs: Record<string, string>): DirectiveNode {
  return { type: 'leafDirective', name: 'video', attributes: attrs, children: [] };
}

async function render(attrs: Record<string, string>, videos: VideoMap): Promise<string> {
  const widgets = new WidgetRegistry();
  widgets.register(videoWidget);
  return widgets.dispatch('video', node(attrs), { images: new Map(), videos, widgets });
}

// ---- attribute parsing -------------------------------------------------

test('parseTrim: "2.0-45.5" seconds -> {startMs, endMs}', () => {
  assert.deepEqual(parseTrim('2.0-45.5'), { startMs: 2000, endMs: 45500 });
});

test('parseTrim rejects reversed ranges and malformed input', () => {
  assert.equal(parseTrim('45.5-2.0'), null);
  assert.equal(parseTrim('2.0'), null);
  assert.equal(parseTrim('abc-def'), null);
  assert.equal(parseTrim(''), null);
});

test('parsePoster: float seconds -> ms; invalid -> null', () => {
  assert.equal(parsePoster('1.5'), 1500);
  assert.equal(parsePoster('0'), 0);
  assert.equal(parsePoster('abc'), null);
  assert.equal(parsePoster(''), null);
});

test('parseVideoWidth reuses the figure width parser (explicit unit only)', () => {
  assert.equal(parseVideoWidth('50%'), '50%');
  assert.equal(parseVideoWidth('300px'), '300px');
  assert.equal(parseVideoWidth('300'), null);
  assert.equal(parseVideoWidth(undefined), null);
});

test('validateVideoAttrs rejects a comma-list ids', () => {
  assert.equal(validateVideoAttrs({ ids: 'a,b' }).ok, false);
});

test('validateVideoAttrs rejects ids that are not 64-hex', () => {
  assert.equal(validateVideoAttrs({ ids: 'abc' }).ok, false);
  assert.equal(validateVideoAttrs({}).ok, false);
});

test('validateVideoAttrs accepts a single 64-hex id with defaults', () => {
  const r = validateVideoAttrs({ ids: HEX64.toUpperCase() });
  assert.equal(r.ok, true);
  if (r.ok) {
    // Lowercased, controls default true, trim/poster default null.
    assert.equal(r.attrs.ids, HEX64);
    assert.equal(r.attrs.controls, true);
    assert.equal(r.attrs.autoplay, false);
    assert.equal(r.attrs.trim, null);
    assert.equal(r.attrs.poster, null);
    assert.equal(r.attrs.caption, null);
  }
});

test('validateVideoAttrs rejects malformed trim and poster', () => {
  assert.equal(validateVideoAttrs({ ids: HEX64, trim: 'start-end' }).ok, false);
  assert.equal(validateVideoAttrs({ ids: HEX64, trim: '9-2' }).ok, false);
  assert.equal(validateVideoAttrs({ ids: HEX64, poster: 'soon' }).ok, false);
});

test('validateVideoAttrs parses trim, poster, booleans, width, caption', () => {
  const r = validateVideoAttrs({
    ids: HEX64,
    trim: '2.0-45.5',
    poster: '1.5',
    controls: 'false',
    autoplay: 'true',
    muted: 'true',
    loop: 'true',
    width: '50%',
    justify: 'left',
    caption: 'demo reel'
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.attrs.trim, { startMs: 2000, endMs: 45500 });
    assert.equal(r.attrs.poster, 1500);
    assert.equal(r.attrs.controls, false);
    assert.equal(r.attrs.autoplay, true);
    assert.equal(r.attrs.muted, true);
    assert.equal(r.attrs.loop, true);
    assert.equal(r.attrs.width, '50%');
    assert.equal(r.attrs.justify, 'left');
    assert.equal(r.attrs.caption, 'demo reel');
  }
});

// ---- rendering ---------------------------------------------------------

test('renders video with poster, aspect reservation, source dims, duration', async (t) => {
  const videos = await mapWith(t, validSidecar());
  const html = await render({ ids: HEX64 }, videos);

  assert.match(html, /<figure class="rkr-video rkr-justify-center"/);
  assert.match(html, /<div class="rkr-video-wrapper" style="--rkr-video-aspect: 640\/480"/);
  assert.match(html, /<video controls preload="metadata"/);
  assert.match(html, /poster="\/video\/poster\//);
  assert.match(html, /src="\/video\/[0-9a-f]{64}\.[0-9a-f]{12}\.mp4"/);
  assert.match(html, /width="640" height="480"/);
  assert.match(html, /data-duration="60000"/);
  assert.doesNotMatch(html, /autoplay/);
});

test('renders a valid trim and poster override into different derivative URLs', async (t) => {
  const videos = await mapWith(t, validSidecar());
  const plain = await render({ ids: HEX64 }, videos);
  const trimmed = await render({ ids: HEX64, trim: '2.0-45.5', poster: '1.5' }, videos);

  assert.notEqual(trimmed, plain);
  // Trim ops flow into the URL hash; the sidecar poster time is overridden.
  assert.match(trimmed, /poster="\/video\/poster\//);
  assert.match(trimmed, /data-duration="60000"/);
});

test('trim beyond duration -> invalid video widget comment', async (t) => {
  const videos = await mapWith(t, validSidecar());
  const html = await render({ ids: HEX64, trim: '2-100' }, videos);
  assert.match(html, /<!-- invalid video widget/);
});

test('unknown id -> missing video comment', async (t) => {
  const videos = await mapWith(t, validSidecar());
  const html = await render({ ids: '0'.repeat(64) }, videos);
  assert.match(html, /<!-- missing video: 0+ -->/);
});

test('autoplay forces muted + playsinline', async (t) => {
  const videos = await mapWith(t, validSidecar());
  const html = await render({ ids: HEX64, autoplay: 'true', loop: 'true' }, videos);
  assert.match(html, /<video controls preload="metadata"[^>]*autoplay muted loop playsinline/);
});

test('muted alone emits muted without playsinline', async (t) => {
  const videos = await mapWith(t, validSidecar());
  const html = await render({ ids: HEX64, muted: 'true' }, videos);
  assert.match(html, /<video controls preload="metadata"[^>]* muted>/);
  assert.doesNotMatch(html, /playsinline/);
});

test('controls=false omits the controls attribute', async (t) => {
  const videos = await mapWith(t, validSidecar());
  const html = await render({ ids: HEX64, controls: 'false' }, videos);
  assert.doesNotMatch(html, / controls /);
  assert.match(html, /<video preload="metadata"/);
});

test('caption renders in figcaption.rkr-video-caption', async (t) => {
  const videos = await mapWith(t, validSidecar());
  const html = await render({ ids: HEX64, caption: 'demo reel' }, videos);
  assert.match(html, /<figcaption class="rkr-video-caption">demo reel<\/figcaption>/);
});

test('justify=left with width applies the width style', async (t) => {
  const videos = await mapWith(t, validSidecar());
  const html = await render({ ids: HEX64, justify: 'left', width: '50%' }, videos);
  assert.match(html, /<figure class="rkr-video rkr-justify-left" style="width: 50%"/);
});

test('justify=inline falls back to center (no inline videos)', async (t) => {
  const videos = await mapWith(t, validSidecar());
  const html = await render({ ids: HEX64, justify: 'inline' }, videos);
  assert.match(html, /<figure class="rkr-video rkr-justify-center"/);
});
