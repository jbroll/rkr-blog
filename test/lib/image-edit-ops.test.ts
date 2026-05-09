import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  describeOp,
  isDirty,
  type LocalEditState,
  localDeleteAt,
  localMutate,
  localRedo,
  localUndo
} from '../../src/lib/image-edit-ops.ts';
import type { SidecarOp } from '../../src/lib/sidecar-types.ts';

const ROT90: SidecarOp = { type: 'rotate', degrees: 90 };
const FLIPH: SidecarOp = { type: 'flip', axis: 'horizontal' };
const CROP: SidecarOp = { type: 'crop', x: 10, y: 20, w: 100, h: 200 };

function freshState(ops: SidecarOp[] = [], redoStack: SidecarOp[] = []): LocalEditState {
  return {
    ops: [...ops],
    redoStack: [...redoStack],
    baseline: { ops: [...ops], redoStack: [...redoStack] },
    sourceWidth: 800,
    sourceHeight: 600
  };
}

// ---- isDirty ----------------------------------------------------------

test('isDirty: state matching baseline → false', () => {
  const s = freshState([ROT90, CROP]);
  assert.equal(isDirty(s), false);
});

test('isDirty: ops diverged from baseline → true', () => {
  const s = freshState([ROT90]);
  s.ops = [...s.ops, FLIPH];
  assert.equal(isDirty(s), true);
});

test('isDirty: redoStack diverged → true', () => {
  const s = freshState([ROT90]);
  s.redoStack = [FLIPH];
  assert.equal(isDirty(s), true);
});

test('isDirty: same ops with reordered keys still equal (canonicalJson)', () => {
  // Build the "same" crop op with keys in a different insertion order.
  // canonicalJson normalizes both sides so isDirty stays false.
  const cropA: SidecarOp = { type: 'crop', x: 1, y: 2, w: 3, h: 4 };
  const cropB: SidecarOp = { h: 4, w: 3, y: 2, x: 1, type: 'crop' } as SidecarOp;
  const s: LocalEditState = {
    ops: [cropA],
    redoStack: [],
    baseline: { ops: [cropB], redoStack: [] },
    sourceWidth: null,
    sourceHeight: null
  };
  assert.equal(isDirty(s), false);
});

// ---- localMutate ------------------------------------------------------

test('localMutate: applies mutator + clears redoStack', () => {
  const s = freshState([ROT90], [CROP]);
  localMutate(s, (ops) => [...ops, FLIPH]);
  assert.deepEqual(s.ops, [ROT90, FLIPH]);
  assert.deepEqual(s.redoStack, []);
});

test('localMutate: mutator can return new array (immutable style)', () => {
  const s = freshState([ROT90, FLIPH]);
  localMutate(s, (ops) => ops.filter((o) => o.type !== 'flip'));
  assert.deepEqual(s.ops, [ROT90]);
});

// ---- localUndo / localRedo --------------------------------------------

test('localUndo: empty ops → no-op', () => {
  const s = freshState([], [ROT90]);
  localUndo(s);
  assert.deepEqual(s.ops, []);
  assert.deepEqual(s.redoStack, [ROT90]);
});

test('localUndo: pops last op onto redoStack', () => {
  const s = freshState([ROT90, FLIPH]);
  localUndo(s);
  assert.deepEqual(s.ops, [ROT90]);
  assert.deepEqual(s.redoStack, [FLIPH]);
});

test('localRedo: empty redoStack → no-op', () => {
  const s = freshState([ROT90]);
  localRedo(s);
  assert.deepEqual(s.ops, [ROT90]);
  assert.deepEqual(s.redoStack, []);
});

test('localRedo: pops last redo back onto ops', () => {
  const s = freshState([ROT90], [FLIPH, CROP]);
  localRedo(s);
  assert.deepEqual(s.ops, [ROT90, CROP]);
  assert.deepEqual(s.redoStack, [FLIPH]);
});

test('undo→redo: round-trips state', () => {
  const s = freshState([ROT90, FLIPH, CROP]);
  localUndo(s);
  localUndo(s);
  localRedo(s);
  localRedo(s);
  assert.deepEqual(s.ops, [ROT90, FLIPH, CROP]);
  assert.deepEqual(s.redoStack, []);
});

test('mutate after undo: clears redoStack (linear-undo invariant)', () => {
  const s = freshState([ROT90, FLIPH]);
  localUndo(s);
  assert.deepEqual(s.redoStack, [FLIPH]);
  localMutate(s, (ops) => [...ops, CROP]);
  assert.deepEqual(s.redoStack, []);
});

// ---- localDeleteAt ----------------------------------------------------

test('localDeleteAt: removes the indexed op', () => {
  const s = freshState([ROT90, FLIPH, CROP]);
  localDeleteAt(s, 1);
  assert.deepEqual(s.ops, [ROT90, CROP]);
});

test('localDeleteAt: out-of-range index → no-op', () => {
  const s = freshState([ROT90]);
  localDeleteAt(s, 5);
  localDeleteAt(s, -1);
  assert.deepEqual(s.ops, [ROT90]);
});

// ---- describeOp -------------------------------------------------------

test('describeOp: crop renders W×H @ x,y', () => {
  assert.equal(describeOp({ type: 'crop', x: 10, y: 20, w: 100, h: 200 }), 'crop 100×200 @ 10,20');
});

test('describeOp: crop with non-numeric coords → 0', () => {
  assert.equal(
    describeOp({ type: 'crop', x: NaN, y: NaN, w: NaN, h: NaN } as unknown as SidecarOp),
    'crop 0×0 @ 0,0'
  );
});

test('describeOp: rotate', () => {
  assert.equal(describeOp({ type: 'rotate', degrees: -90 }), 'rotate -90°');
  assert.equal(describeOp({ type: 'rotate', degrees: 90 }), 'rotate 90°');
});

test('describeOp: flip', () => {
  assert.equal(describeOp({ type: 'flip', axis: 'horizontal' }), 'flip horizontal');
  assert.equal(describeOp({ type: 'flip', axis: 'vertical' }), 'flip vertical');
});

test('describeOp: resample', () => {
  assert.equal(describeOp({ type: 'resample', w: 800, fit: 'inside' }), 'resample max-w 800');
});

test('describeOp: perspective with corners', () => {
  const op: SidecarOp = {
    type: 'perspective',
    corners: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10]
    ]
  };
  assert.equal(describeOp(op), 'perspective 4-corner');
});

test('describeOp: perspective with non-array corners → 0-corner', () => {
  assert.equal(
    describeOp({ type: 'perspective', corners: undefined } as unknown as SidecarOp),
    'perspective 0-corner'
  );
});

test('describeOp: unknown op type → raw type', () => {
  assert.equal(
    describeOp({ type: 'zoom-and-enhance' } as unknown as SidecarOp),
    'zoom-and-enhance'
  );
});
