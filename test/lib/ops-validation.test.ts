// Coverage for dimensionsAfterOps — the post-ops effective-dim
// helper used by widget templates so that a cropped/rotated image
// lays out at the correct aspect ratio. Pre-feature widgets used the
// raw sidecar.metadata.width/height, which gave the wrong aspect for
// any image with an ops pipeline.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dimensionsAfterOps } from '../../src/lib/ops-validation.ts';
import type { SidecarOp } from '../../src/lib/sidecar-types.ts';

test('dimensionsAfterOps: no ops → passes metadata through', () => {
  const d = dimensionsAfterOps({ width: 4000, height: 3000 }, []);
  assert.deepEqual(d, { width: 4000, height: 3000 });
});

test('dimensionsAfterOps: crop replaces dims', () => {
  // 4000×3000 source, top half cropped → 4000×1500. Aspect goes
  // from 4:3 to 8:3; widget --aspect must reflect that.
  const ops: SidecarOp[] = [{ type: 'crop', x: 0, y: 0, w: 4000, h: 1500 }];
  const d = dimensionsAfterOps({ width: 4000, height: 3000 }, ops);
  assert.deepEqual(d, { width: 4000, height: 1500 });
});

test('dimensionsAfterOps: rotate 90/270 swaps; 0/180 preserves', () => {
  const md = { width: 4000, height: 3000 };
  assert.deepEqual(dimensionsAfterOps(md, [{ type: 'rotate', degrees: 90 }]), {
    width: 3000,
    height: 4000
  });
  assert.deepEqual(dimensionsAfterOps(md, [{ type: 'rotate', degrees: 270 }]), {
    width: 3000,
    height: 4000
  });
  assert.deepEqual(dimensionsAfterOps(md, [{ type: 'rotate', degrees: 180 }]), {
    width: 4000,
    height: 3000
  });
});

test('dimensionsAfterOps: flip preserves dims', () => {
  assert.deepEqual(
    dimensionsAfterOps({ width: 100, height: 50 }, [{ type: 'flip', axis: 'horizontal' }]),
    { width: 100, height: 50 }
  );
});

test('dimensionsAfterOps: crop then rotate composes', () => {
  // Crop to 4000×1500 then rotate 90° → 1500×4000.
  const ops: SidecarOp[] = [
    { type: 'crop', x: 0, y: 0, w: 4000, h: 1500 },
    { type: 'rotate', degrees: 90 }
  ];
  const d = dimensionsAfterOps({ width: 4000, height: 3000 }, ops);
  assert.deepEqual(d, { width: 1500, height: 4000 });
});

test('dimensionsAfterOps: resample fit=inside scales to constraint without enlargement', () => {
  // 4000×3000 → fit inside 800×800 → 800×600.
  const d = dimensionsAfterOps({ width: 4000, height: 3000 }, [
    { type: 'resample', w: 800, h: 800, fit: 'inside' }
  ]);
  assert.deepEqual(d, { width: 800, height: 600 });
});

test('dimensionsAfterOps: resample with only w preserves aspect', () => {
  const d = dimensionsAfterOps({ width: 4000, height: 3000 }, [{ type: 'resample', w: 1000 }]);
  assert.deepEqual(d, { width: 1000, height: 750 });
});

test('dimensionsAfterOps: resample target larger than source is a no-op (withoutEnlargement)', () => {
  const d = dimensionsAfterOps({ width: 800, height: 600 }, [
    { type: 'resample', w: 4000, h: 3000 }
  ]);
  assert.deepEqual(d, { width: 800, height: 600 });
});

test('dimensionsAfterOps: zero / missing metadata returns 0×0 unchanged', () => {
  // Layout shouldn't crash on a sidecar that somehow lacks
  // dimensions; the caller defaults the aspect to 1:1.
  assert.deepEqual(dimensionsAfterOps({ width: 0, height: 0 }, []), { width: 0, height: 0 });
  assert.deepEqual(dimensionsAfterOps({}, [{ type: 'crop', x: 0, y: 0, w: 100, h: 50 }]), {
    width: 0,
    height: 0
  });
});

test('dimensionsAfterOps: perspective uses corner bbox as heuristic', () => {
  // The canvas may rectify to smaller output; widget layout aspect
  // only needs an approximation.
  const ops: SidecarOp[] = [
    {
      type: 'perspective',
      corners: [
        [100, 200],
        [900, 250],
        [950, 800],
        [80, 750]
      ]
    }
  ];
  const d = dimensionsAfterOps({ width: 1000, height: 1000 }, ops);
  assert.deepEqual(d, { width: 870, height: 600 });
});
