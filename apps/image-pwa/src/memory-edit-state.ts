// In-memory edit state for the standalone PWA: the blog's image-edit.ts minus
// all server / OPFS / outbox / cross-tab machinery. Holds one LocalEditState
// and drives a preview refresh on every change via the pure core mutators.

import {
  appendFlip,
  appendRotate,
  type LocalEditState,
  localRedo,
  localUndo,
  type SidecarOp
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

export interface TiltSession {
  /** Apply the slider's current angle, absolute within this drag. */
  move: (degrees: number) => void;
  /** Release, or anything else touching the rotation, ends the drag. */
  end: () => void;
}

/** One tilt drag re-applies onto the ops as they stood when it began,
 * rather than onto whatever the previous event left behind. A slider
 * that sends deltas drifts out of step with the image as soon as
 * anything else touches the rotation: an undo pops the whole merged
 * rotate op while the thumb stays where it was, and every later
 * reading is off by that much. Re-reading the base each drag also
 * collapses the drag to a single undo step. */
export function createTiltSession(m: MemoryState): TiltSession {
  let base: SidecarOp[] | null = null;
  return {
    move(degrees: number): void {
      base ??= m.state.ops;
      m.state.ops = appendRotate(base, degrees);
      m.state.redoStack = [];
      m.onChange();
    },
    end(): void {
      base = null;
    }
  };
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
