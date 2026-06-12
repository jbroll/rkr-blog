// Headless workflow: drive the PWA's in-memory edit state through a realistic
// op sequence and assert the result validates against the source dimensions —
// exercising the real @rkr/image-edit core the way the app does, no browser.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type SidecarOp, validateOps } from '@rkr/image-edit';
import {
  applyFlip,
  applyRotate,
  createMemoryState
} from '../../apps/image-pwa/src/memory-edit-state.ts';

test('rotate + flip ops validate against the source dimensions', () => {
  const m = createMemoryState(1200, 800);
  applyRotate(m, 90);
  applyFlip(m, 'horizontal');
  const res = validateOps(m.state.ops, { width: 1200, height: 800 });
  assert.equal(res.ok, true, res.ok ? '' : res.error);
});

test('an in-bounds crop op (appended as the modals do) validates', () => {
  const m = createMemoryState(1000, 1000);
  const crop: SidecarOp = { type: 'crop', x: 100, y: 100, w: 400, h: 400 };
  m.state.ops = [...m.state.ops, crop];
  const res = validateOps(m.state.ops, { width: 1000, height: 1000 });
  assert.equal(res.ok, true, res.ok ? '' : res.error);
});

test('an out-of-bounds crop op is rejected', () => {
  const crop: SidecarOp = { type: 'crop', x: 0, y: 0, w: 5000, h: 5000 };
  const res = validateOps([crop], { width: 1000, height: 1000 });
  assert.equal(res.ok, false);
});
