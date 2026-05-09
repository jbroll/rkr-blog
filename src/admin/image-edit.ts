// Local edit state for the image-attributes panel: undo/redo, op
// mutators, and the Save flow that commits ops + bake to the server.
//
// Edits live in the browser until the user hits "Save edits". Each
// click (rotate / flip / crop / resample / undo / redo / delete-step /
// reset) mutates this in-memory state and re-renders the preview via
// the canvas pipeline. No server round-trip per click.
//
// Save commits ops + redoStack to /admin/sidecar/:id/ops AND uploads
// the baked WebP to /admin/sidecar/:id/bake. `baseline` tracks what
// the server has so we can detect "dirty" (Save button enabled) and
// undo unsaved local edits if needed.

import { canonicalJson } from '../lib/canonical-json.ts';
import type { SidecarOp } from '../lib/sidecar-types.ts';
import { canvasToBlob, getPipelineCache, loadOriginal, uploadBake } from './canvas-loaders';

interface SidecarMeta {
  width: number | null;
  height: number | null;
  format: string | null;
  ops: SidecarOp[];
  redoStack: SidecarOp[];
}

async function fetchSidecarMeta(id: string): Promise<SidecarMeta> {
  const res = await fetch(`/admin/sidecar/${id}/meta`);
  if (!res.ok) throw new Error(`meta: ${res.status}`);
  return (await res.json()) as SidecarMeta;
}

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

const localEditState = new Map<string, LocalEditState>();

/** Read the cached state for an id without fetching (`undefined` if
 * the user hasn't focused the figure yet). Distinct from
 * `ensureLocalState`, which lazily fetches from the server. */
export function getLocalEditState(id: string): LocalEditState | undefined {
  return localEditState.get(id);
}

/** Lazy-load the local state for an id from the server. Subsequent
 * accesses reuse the cached state, preserving any in-progress edits
 * across selection changes. */
export async function ensureLocalState(id: string): Promise<LocalEditState> {
  const cached = localEditState.get(id);
  if (cached) return cached;
  const meta = await fetchSidecarMeta(id);
  const fresh: LocalEditState = {
    ops: [...meta.ops],
    redoStack: [...meta.redoStack],
    baseline: { ops: [...meta.ops], redoStack: [...meta.redoStack] },
    sourceWidth: meta.width,
    sourceHeight: meta.height
  };
  localEditState.set(id, fresh);
  return fresh;
}

/** True when local ops or redoStack diverge from the server-known
 * baseline — drives the "Save edits" button enable state and the
 * post-save dirty-flush flow. */
export function isDirty(s: LocalEditState): boolean {
  // Use canonicalJson rather than JSON.stringify so two semantically
  // equivalent op chains compare equal regardless of object-key
  // insertion order — ops can be built by the cropper, the perspective
  // modal, runEdit, or the round-tripped server response, each of
  // which may emit keys in a different order.
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

/** Server-side commit of one image's local edits (Save button). */
async function postOpsToServer(
  id: string,
  ops: SidecarOp[],
  redoStack: SidecarOp[]
): Promise<void> {
  const res = await fetch(`/admin/sidecar/${id}/ops`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ops, redoStack })
  });
  if (!res.ok) throw new Error(`ops: ${res.status} ${await res.text()}`);
}

/** POST ops + redoStack (unlinks any prior bake), then if ops remain
 * apply them on the master and POST the WebP to /bake. Baseline updates
 * only after both land — partial commits stay dirty for retry. */
export async function saveImageEdits(id: string, s: LocalEditState): Promise<void> {
  // Snapshot the prior server-known state before mutating: if /ops
  // succeeds but /bake fails, we restore the snapshot so the public
  // site doesn't end up serving 500s for an `ops` chain whose bake
  // never landed (notably, `perspective` is client-only — sharp can't
  // apply a homography, so a missing bake means `unknown op type`
  // until the next save).
  const priorOps = [...s.baseline.ops];
  const priorRedo = [...s.baseline.redoStack];

  await postOpsToServer(id, s.ops, s.redoStack);
  if (s.ops.length > 0) {
    try {
      const original = await loadOriginal(id);
      const canvas = getPipelineCache(id).apply(
        {
          drawable: original,
          width: original.naturalWidth,
          height: original.naturalHeight
        },
        s.ops
      );
      const blob = await canvasToBlob(canvas, 'image/webp', 0.95);
      await uploadBake(id, blob);
    } catch (err) {
      // Roll back the server's view of ops to the prior baseline so
      // the public site stays in a coherent state. Best-effort: if
      // this also fails the user's session is offline — the local
      // state stays dirty for retry, and beforeunload will warn
      // before the user loses work to a reload.
      await postOpsToServer(id, priorOps, priorRedo).catch(() => {
        /* network gone; user retries */
      });
      throw err;
    }
  }
  s.baseline = { ops: [...s.ops], redoStack: [...s.redoStack] };
}

/** Snapshot the in-memory edit state for every image whose local ops
 * differ from server baseline. The post-Save flow auto-commits these
 * before writing the markdown, and `beforeunload` blocks reload while
 * any are present. */
export function dirtyImageStates(): Array<[string, LocalEditState]> {
  const out: Array<[string, LocalEditState]> = [];
  for (const [id, s] of localEditState) {
    if (isDirty(s)) out.push([id, s]);
  }
  return out;
}

/** Save every dirty image's edits in parallel via Promise.allSettled.
 * Returns counts so the caller can surface progress; rejected promises
 * leave `baseline` untouched (image stays dirty). */
export async function flushDirtyImageEdits(): Promise<{ ok: number; failed: number }> {
  const dirty = dirtyImageStates();
  if (dirty.length === 0) return { ok: 0, failed: 0 };
  const results = await Promise.allSettled(dirty.map(([id, s]) => saveImageEdits(id, s)));
  let ok = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') ok++;
    else failed++;
  }
  return { ok, failed };
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
