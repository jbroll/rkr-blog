import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mimeFor, outputName } from '../../apps/image-pwa/src/download.ts';

test('mimeFor maps each format', () => {
  assert.equal(mimeFor('png'), 'image/png');
  assert.equal(mimeFor('webp'), 'image/webp');
  assert.equal(mimeFor('jpeg'), 'image/jpeg');
});

test('outputName swaps the extension to <stem>-edited.<fmt>', () => {
  assert.equal(outputName('photo.jpg', 'webp'), 'photo-edited.webp');
  assert.equal(outputName('a.b.c.png', 'jpeg'), 'a.b.c-edited.jpeg');
  assert.equal(outputName('no-ext', 'png'), 'no-ext-edited.png');
  assert.equal(outputName('.hidden', 'png'), '.hidden-edited.png');
});
