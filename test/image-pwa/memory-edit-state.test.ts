import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyFlip,
  applyRotate,
  canRedo,
  canUndo,
  createMemoryState,
  createTiltSession,
  redo,
  undo
} from '../../apps/image-pwa/src/memory-edit-state.ts';

test('createMemoryState seeds empty ops + source dims', () => {
  const m = createMemoryState(800, 600);
  assert.deepEqual(m.state.ops, []);
  assert.equal(m.state.sourceWidth, 800);
  assert.equal(m.state.sourceHeight, 600);
  assert.equal(canUndo(m), false);
});

test('rotate appends a rotate op and fires onChange', () => {
  const m = createMemoryState(800, 600);
  let changes = 0;
  m.onChange = () => changes++;
  applyRotate(m, 90);
  assert.equal(m.state.ops.length, 1);
  assert.equal(m.state.ops[0]?.type, 'rotate');
  assert.equal(changes, 1);
  assert.equal(canUndo(m), true);
});

test('adjacent same-axis flips cancel (delegates to core appendFlip)', () => {
  const m = createMemoryState(800, 600);
  applyFlip(m, 'horizontal');
  applyFlip(m, 'horizontal');
  assert.deepEqual(m.state.ops, []);
});

test('undo moves the op to the redo stack; redo restores it', () => {
  const m = createMemoryState(800, 600);
  applyRotate(m, 90);
  undo(m);
  assert.equal(m.state.ops.length, 0);
  assert.equal(canRedo(m), true);
  redo(m);
  assert.equal(m.state.ops.length, 1);
  assert.equal(canRedo(m), false);
});

test('a fresh edit clears the redo stack', () => {
  const m = createMemoryState(800, 600);
  applyRotate(m, 90);
  undo(m);
  assert.equal(canRedo(m), true);
  applyFlip(m, 'vertical');
  assert.equal(canRedo(m), false);
});

test('a tilt drag is one op however many events it emits', () => {
  const m = createMemoryState(800, 600);
  const tilt = createTiltSession(m);
  tilt.move(3);
  tilt.move(7);
  tilt.move(5);
  assert.deepEqual(m.state.ops, [{ type: 'rotate', degrees: 5 }]);
  undo(m);
  assert.deepEqual(m.state.ops, []);
});

test('a tilt drag adds to an existing 90 turn without compounding per event', () => {
  const m = createMemoryState(800, 600);
  applyRotate(m, 90);
  const tilt = createTiltSession(m);
  tilt.move(4);
  tilt.move(6);
  assert.deepEqual(m.state.ops, [{ type: 'rotate', degrees: 96 }]);
});

test('returning a drag to zero restores the ops it started from', () => {
  const m = createMemoryState(800, 600);
  applyRotate(m, 90);
  const tilt = createTiltSession(m);
  tilt.move(9);
  tilt.move(0);
  assert.deepEqual(m.state.ops, [{ type: 'rotate', degrees: 90 }]);
});

test('undoing a tilt then tilting again does not apply a phantom delta', () => {
  const m = createMemoryState(800, 600);
  const tilt = createTiltSession(m);
  tilt.move(5);
  tilt.end();
  undo(m);
  assert.deepEqual(m.state.ops, []);
  // The slider has re-centred, so the next drag opens at zero. A
  // delta-from-last slider would send 0 - 5 here and leave rotate 355
  // on an image the user just returned to upright.
  tilt.move(0);
  assert.deepEqual(m.state.ops, []);
});
