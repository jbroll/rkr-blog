import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyFlip,
  applyRotate,
  canRedo,
  canUndo,
  createMemoryState,
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
