// The video widget's `variants × poster × fallback` declaration is the
// source of truth for what URLs the rendered HTML emits. Each must match
// the render pipeline's own width constants (video-render.ts) so the
// declared widths and the cache-ophash widths stay aligned. Mirrors
// widget-fallback-alignment.test.ts for the figure widget.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { POSTER_MAX_WIDTH, VIDEO_MAX_WIDTH } from '../../src/lib/video-render.ts';
import * as videoWidget from '../../src/widgets/video.ts';

test(`widget 'video': variant width matches VIDEO_MAX_WIDTH, formats include mp4`, () => {
  for (const v of videoWidget.variants) {
    assert.equal(v.w, VIDEO_MAX_WIDTH);
    assert.ok(v.formats.includes('mp4'), `variant w=${v.w} missing mp4 format`);
  }
});

test(`widget 'video': poster and fallback widths match POSTER_MAX_WIDTH as jpg`, () => {
  assert.equal(videoWidget.poster.w, POSTER_MAX_WIDTH);
  assert.equal(videoWidget.poster.format, 'jpg');
  assert.equal(videoWidget.fallback.w, POSTER_MAX_WIDTH);
  assert.equal(videoWidget.fallback.format, 'jpg');
});
