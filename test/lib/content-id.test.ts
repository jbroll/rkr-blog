import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeContentId, extForMime } from '../../src/lib/content-id.ts';

test('computeContentId: empty buffer → known sha256', async () => {
  // Standard sha256 of zero bytes.
  assert.equal(
    await computeContentId(new Blob([])),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
});

test('computeContentId: same bytes → same id (content-addressed)', async () => {
  const bytes = new TextEncoder().encode('hello rkroll');
  const a = await computeContentId(new Blob([bytes]));
  const b = await computeContentId(new Blob([bytes]));
  assert.equal(a, b);
});

test('computeContentId: different bytes → different ids', async () => {
  const a = await computeContentId(new Blob([new TextEncoder().encode('a')]));
  const b = await computeContentId(new Blob([new TextEncoder().encode('b')]));
  assert.notEqual(a, b);
});

test('computeContentId: 64-hex-char output', async () => {
  const id = await computeContentId(new Blob([new TextEncoder().encode('test')]));
  assert.match(id, /^[0-9a-f]{64}$/);
});

test('extForMime: known image types', () => {
  assert.equal(extForMime('image/jpeg'), 'jpeg');
  assert.equal(extForMime('image/JPEG'), 'jpeg');
  assert.equal(extForMime('image/jpg'), 'jpeg');
  assert.equal(extForMime('image/png'), 'png');
  assert.equal(extForMime('image/webp'), 'webp');
  assert.equal(extForMime('image/avif'), 'avif');
  assert.equal(extForMime('image/heic'), 'heic');
  assert.equal(extForMime('image/heif'), 'heic');
});

test('extForMime: unknown / empty → bin (server normalizes on upload)', () => {
  assert.equal(extForMime(''), 'bin');
  assert.equal(extForMime('application/octet-stream'), 'bin');
  assert.equal(extForMime('text/plain'), 'bin');
});
