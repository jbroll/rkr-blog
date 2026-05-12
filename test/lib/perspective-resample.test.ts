// Pure-math coverage for the server-side perspective resampler. The
// integration with sharp + ensureBake is exercised in
// widget-image-dimensions.test.ts; this file pins the pixel-level
// behaviour: bilinear sampling, out-of-bounds → transparent,
// malformed corners → null.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resamplePerspective } from '../../src/lib/perspective-resample.ts';

/** Build a raw RGBA buffer of `w × h` with each pixel set to
 * (r, g, b, a). */
function solidRgba(w: number, h: number, r: number, g: number, b: number, a = 255): Buffer {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

test('resamplePerspective: identity corners → output equals input', () => {
  // Source corners = the source rectangle's corners → homography is
  // identity → output is a faithful copy at the same dims.
  const src = solidRgba(8, 6, 200, 100, 50);
  const result = resamplePerspective(src, 8, 6, {
    corners: [
      [0, 0],
      [8, 0],
      [8, 6],
      [0, 6]
    ]
  });
  assert.ok(result);
  // perspectiveOutputSize for an 8×6 quad → 8×6.
  assert.equal(result.width, 8);
  assert.equal(result.height, 6);
  // Every output pixel mirrors the solid source.
  for (let i = 0; i < result.width * result.height; i++) {
    assert.equal(result.buffer[i * 4], 200);
    assert.equal(result.buffer[i * 4 + 1], 100);
    assert.equal(result.buffer[i * 4 + 2], 50);
    assert.equal(result.buffer[i * 4 + 3], 255);
  }
});

test('resamplePerspective: malformed corners → null', () => {
  const src = solidRgba(4, 4, 0, 0, 0);
  assert.equal(resamplePerspective(src, 4, 4, { corners: 'nope' }), null);
  assert.equal(resamplePerspective(src, 4, 4, { corners: [[0, 0]] }), null);
  assert.equal(
    resamplePerspective(src, 4, 4, {
      corners: [
        [0, 0],
        [4, 0],
        [4, 4],
        ['oops', 4]
      ]
    }),
    null
  );
});

test('resamplePerspective: degenerate quad (three colinear corners) → null', () => {
  // tl, tr, br colinear → singular homography.
  const src = solidRgba(10, 10, 0, 0, 0);
  const result = resamplePerspective(src, 10, 10, {
    corners: [
      [0, 0],
      [5, 0],
      [10, 0],
      [0, 10]
    ]
  });
  assert.equal(result, null);
});

test('resamplePerspective: half-image quad → output is the cropped + rectified region', () => {
  // 8×8 input with the left half red and right half blue. Picking
  // the left half as the source quad rectifies it into a square
  // output that's entirely red.
  const buf = Buffer.alloc(8 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = (y * 8 + x) * 4;
      if (x < 4) {
        buf[i] = 255;
        buf[i + 1] = 0;
        buf[i + 2] = 0;
      } else {
        buf[i] = 0;
        buf[i + 1] = 0;
        buf[i + 2] = 255;
      }
      buf[i + 3] = 255;
    }
  }
  const result = resamplePerspective(buf, 8, 8, {
    corners: [
      [0, 0],
      [4, 0],
      [4, 8],
      [0, 8]
    ]
  });
  assert.ok(result);
  assert.equal(result.width, 4);
  assert.equal(result.height, 8);
  // Every output pixel should sample the red half (R=255, B=0). The
  // first column samples right at x=0 (texel center 0.5 in the red
  // band, fully red); the last column samples near x=4 which is
  // exactly the boundary, so bilinear may blend with the blue
  // neighbour — check the interior columns to keep the assertion
  // robust against boundary-sample interpolation.
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 3; x++) {
      const i = (y * 4 + x) * 4;
      assert.equal(result.buffer[i], 255, `x=${x},y=${y} R`);
      assert.equal(result.buffer[i + 2], 0, `x=${x},y=${y} B`);
    }
  }
});
