import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as canvas from '@rkr/image-edit/canvas';

// The two consumers (the blog admin SPA and apps/image-pwa) import this
// entry, not the modules behind it, so a rename that lands only in one
// caller shows up here first.
const SURFACE = [
  '$',
  'PipelineCache',
  'canvasToBlob',
  'openCropper',
  'openModal',
  'openPerspective',
  'resizeForUpload',
  'supportsWebP',
  'webpOrJpeg'
];

describe('@rkr/image-edit/canvas entry', () => {
  it('exports exactly its documented surface', () => {
    assert.deepEqual(Object.keys(canvas).sort(), SURFACE);
  });

  it('imports without touching the DOM', () => {
    assert.equal(typeof canvas.PipelineCache, 'function');
    assert.equal(typeof canvas.resizeForUpload, 'function');
  });
});
