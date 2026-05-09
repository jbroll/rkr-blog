// Local edit state for the image-attributes panel: per-id Map +
// fetch/save against the server. The pure state mutators + dirty
// predicate + op formatter live in src/lib/image-edit-ops.ts so c8
// can measure them; this module wires them to the network and the
// canvas pipeline.
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

import { isDirty, type LocalEditState } from '../lib/image-edit-ops.ts';
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
