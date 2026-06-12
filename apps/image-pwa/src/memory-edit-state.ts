// In-memory edit state for the standalone PWA: the blog's image-edit.ts minus
// all server / OPFS / outbox / cross-tab machinery. Holds one LocalEditState
// and drives a preview refresh on every change via the pure core mutators.

import {
  appendFlip,
  appendRotate,
  type LocalEditState,
  localRedo,
  localUndo
} from '@rkr/image-edit';

export interface MemoryState {
  state: LocalEditState;
  /** Invoked after any op change so the host can re-render the preview. */
  onChange: () => void;
}

export function createMemoryState(width: number, height: number): MemoryState {
  return {
    state: {
      ops: [],
      redoStack: [],
      baseline: { ops: [], redoStack: [] },
      sourceWidth: width,
      sourceHeight: height
    },
    onChange: () => {}
  };
}

export function applyRotate(m: MemoryState, degrees: number): void {
  m.state.ops = appendRotate(m.state.ops, degrees);
  m.state.redoStack = [];
  m.onChange();
}

export function applyFlip(m: MemoryState, axis: 'horizontal' | 'vertical'): void {
  m.state.ops = appendFlip(m.state.ops, axis);
  m.state.redoStack = [];
  m.onChange();
}

export function undo(m: MemoryState): void {
  localUndo(m.state);
  m.onChange();
}

export function redo(m: MemoryState): void {
  localRedo(m.state);
  m.onChange();
}

export function canUndo(m: MemoryState): boolean {
  return m.state.ops.length > 0;
}

export function canRedo(m: MemoryState): boolean {
  return m.state.redoStack.length > 0;
}
