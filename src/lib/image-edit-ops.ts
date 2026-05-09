// Pure state mutators + dirty-check + op formatter for the editor's
// image-attribute panel. Lives in src/lib (not src/admin/image-edit.ts)
// so c8 measures it under the standard coverage gate. The wrapper in
// src/admin/image-edit.ts adds the network/DOM-coupled pieces:
// fetchSidecarMeta, ensureLocalState, saveImageEdits, the canvas bake,
// and the localEditState Map that holds these structures per-id.
//
// Linear-undo invariant: any new op (mutate) clears redoStack; undo
// shifts the last op onto redoStack; redo pops it back. localDeleteAt
// is intentionally distinct from undo — deleting a step out of order
// is a separate UX (the per-row "×" buttons in the edits list).

import { canonicalJson } from './canonical-json.ts';
import type { SidecarOp } from './sidecar-types.ts';

export interface LocalEditState {
  ops: SidecarOp[];
  redoStack: SidecarOp[];
  /** Last server-known state. Update on Save. Used for dirty check. */
  baseline: {
    ops: SidecarOp[];
    redoStack: SidecarOp[];
  };
  /** Source dimensions, copied from the sidecar metadata. Used by the
   * cropper to set up its display ratio. */
  sourceWidth: number | null;
  sourceHeight: number | null;
}

/** True when local ops or redoStack diverge from the server-known
 * baseline — drives the "Save edits" button enable state and the
 * post-save dirty-flush flow. Uses canonicalJson rather than
 * JSON.stringify so two semantically equivalent op chains compare
 * equal regardless of object-key insertion order — ops can be built
 * by the cropper, the perspective modal, runEdit, or the
 * round-tripped server response, each of which may emit keys in a
 * different order. */
export function isDirty(s: LocalEditState): boolean {
  return (
    canonicalJson(s.ops) !== canonicalJson(s.baseline.ops) ||
    canonicalJson(s.redoStack) !== canonicalJson(s.baseline.redoStack)
  );
}

/** Mutate the local ops in place; clear redoStack (any new op
 * invalidates redo history, the standard linear-undo invariant). */
export function localMutate(s: LocalEditState, mutator: (ops: SidecarOp[]) => SidecarOp[]): void {
  s.ops = mutator(s.ops);
  s.redoStack = [];
}

export function localUndo(s: LocalEditState): void {
  if (s.ops.length === 0) return;
  const popped = s.ops[s.ops.length - 1] as SidecarOp;
  s.ops = s.ops.slice(0, -1);
  s.redoStack = [...s.redoStack, popped];
}

export function localRedo(s: LocalEditState): void {
  if (s.redoStack.length === 0) return;
  const popped = s.redoStack[s.redoStack.length - 1] as SidecarOp;
  s.ops = [...s.ops, popped];
  s.redoStack = s.redoStack.slice(0, -1);
}

export function localDeleteAt(s: LocalEditState, index: number): void {
  if (index < 0 || index >= s.ops.length) return;
  s.ops = [...s.ops.slice(0, index), ...s.ops.slice(index + 1)];
}

/** Human-readable label for one op, used in the edits list under the
 * image-attributes panel. Tries to format coords / dimensions in a way
 * the author can scan ("crop 400×300 @ 100,50"); falls back to the raw
 * type for anything we don't recognize. */
export function describeOp(op: SidecarOp): string {
  switch (op.type) {
    case 'crop': {
      const w = Number(op.w) || 0;
      const h = Number(op.h) || 0;
      const x = Number(op.x) || 0;
      const y = Number(op.y) || 0;
      return `crop ${w}×${h} @ ${x},${y}`;
    }
    case 'rotate':
      return `rotate ${String(op.degrees)}°`;
    case 'flip':
      return `flip ${String(op.axis)}`;
    case 'resample':
      return `resample max-w ${String(op.w)}`;
    case 'perspective': {
      const c = op.corners;
      const n = Array.isArray(c) ? c.length : 0;
      return `perspective ${n}-corner`;
    }
    default:
      return op.type;
  }
}
