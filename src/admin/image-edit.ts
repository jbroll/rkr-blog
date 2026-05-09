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

import { bakeOpsHash } from '../lib/bake-ops-hash.ts';
import { isDirty, type LocalEditState } from '../lib/image-edit-ops.ts';
import type { SidecarOp } from '../lib/sidecar-types.ts';
import { canvasToBlob, getPipelineCache, loadOriginal, uploadBake } from './canvas-loaders';
import { getState } from './online-state.ts';
import { readJson, writeJson } from './opfs.ts';
import { append as outboxAppend } from './outbox.ts';
import { tryDrain } from './sync.ts';

const IMAGE_STATE_DIR = 'image-state';

interface PersistedImageState {
  schemaVersion: 1;
  id: string;
  ops: SidecarOp[];
  redoStack: SidecarOp[];
  baseline: { ops: SidecarOp[]; redoStack: SidecarOp[] };
  sourceWidth: number | null;
  sourceHeight: number | null;
}

/** Write the current local edit state to OPFS so a tab reload can
 * restore unsaved edits (spec-offline §7 — phase 1i). Called from
 * refreshAfterEdit on every mutation, and from saveImageEdits after
 * baseline updates. Fire-and-forget: persistence failures are
 * surfaced via console only — losing one persist is recoverable
 * (the next mutation re-persists). The e2e ratchet covers the path
 * via the existing rotate-and-save spec.
 * @public */
export function persistImageState(id: string, s: LocalEditState): void {
  const snapshot: PersistedImageState = {
    schemaVersion: 1,
    id,
    ops: [...s.ops],
    redoStack: [...s.redoStack],
    baseline: {
      ops: [...s.baseline.ops],
      redoStack: [...s.baseline.redoStack]
    },
    sourceWidth: s.sourceWidth,
    sourceHeight: s.sourceHeight
  };
  void writeJson(`${IMAGE_STATE_DIR}/${id}.json`, snapshot).catch((err) => {
    /* v8 ignore next 2 -- best-effort write; OPFS quota / IO errors
       surfaced for debug only */
    console.warn(`persistImageState ${id}:`, err);
  });
}

async function loadImageState(id: string): Promise<LocalEditState | null> {
  const raw = await readJson<PersistedImageState>(`${IMAGE_STATE_DIR}/${id}.json`);
  /* v8 ignore next -- absent-file path is the common no-cache case */
  if (!raw) return null;
  return {
    ops: raw.ops,
    redoStack: raw.redoStack,
    baseline: raw.baseline,
    sourceWidth: raw.sourceWidth,
    sourceHeight: raw.sourceHeight
  };
}

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

/** Lazy-load the local state for an id. Order: (1) in-process Map
 * (selection-change preserves edits), (2) OPFS image-state (a
 * reload preserves unsaved edits — phase 1i), (3) server fetch.
 * Subsequent accesses reuse the cached state. */
export async function ensureLocalState(id: string): Promise<LocalEditState> {
  const cached = localEditState.get(id);
  if (cached) return cached;
  const persisted = await loadImageState(id);
  if (persisted) {
    localEditState.set(id, persisted);
    return persisted;
  }
  const meta = await fetchSidecarMeta(id);
  const fresh: LocalEditState = {
    ops: [...meta.ops],
    redoStack: [...meta.redoStack],
    baseline: { ops: [...meta.ops], redoStack: [...meta.redoStack] },
    sourceWidth: meta.width,
    sourceHeight: meta.height
  };
  localEditState.set(id, fresh);
  persistImageState(id, fresh);
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

/** Commit the local ops + bake to either the server (online) or
 * the outbox (offline / online attempt failed). Updates s.baseline
 * either way — "saved" means "committed for sync," not "the server
 * has it yet." Phase 1g savePost-conflict resolution will roll back
 * s.baseline if the drain hits a 409 the user resolves by
 * discarding. */
export async function saveImageEdits(id: string, s: LocalEditState): Promise<void> {
  if (getState() !== 'offline') {
    try {
      await commitOnline(id, s);
      s.baseline = { ops: [...s.ops], redoStack: [...s.redoStack] };
      persistImageState(id, s);
      return;
    } catch (err) {
      // Online attempt failed; before falling back to queue, try to
      // roll back the prior /ops POST if it landed but /bake failed
      // — same reasoning as before, the public site mustn't serve
      // 500s for an ops chain whose bake never landed.
      await postOpsToServer(id, [...s.baseline.ops], [...s.baseline.redoStack]).catch(() => {
        /* fall through */
      });
      // Surface why we fell back; the queue path will retry.
      console.warn('saveImageEdits online failed, queueing offline:', err);
    }
  }

  await commitOffline(id, s);
  s.baseline = { ops: [...s.ops], redoStack: [...s.redoStack] };
  persistImageState(id, s);
}

async function commitOnline(id: string, s: LocalEditState): Promise<void> {
  await postOpsToServer(id, s.ops, s.redoStack);
  if (s.ops.length > 0) {
    const blob = await renderBakeBlob(id, s.ops);
    await uploadBake(id, blob, s.ops);
  }
}

async function commitOffline(id: string, s: LocalEditState): Promise<void> {
  // Append setOps first so the drain order matches the online flow
  // (ops first, bake second — server unlinks bake on ops change).
  await outboxAppend({
    op: 'setOps',
    payload: { id, ops: [...s.ops], redoStack: [...s.redoStack] }
  });
  if (s.ops.length > 0) {
    const blob = await renderBakeBlob(id, s.ops);
    await outboxAppend(
      {
        op: 'bake',
        payload: { id, opsHash: await bakeOpsHash(s.ops) }
      },
      blob
    );
  }
  void tryDrain();
}

async function renderBakeBlob(id: string, ops: readonly SidecarOp[]): Promise<Blob> {
  const original = await loadOriginal(id);
  const canvas = getPipelineCache(id).apply(
    {
      drawable: original,
      width: original.naturalWidth,
      height: original.naturalHeight
    },
    ops as SidecarOp[]
  );
  return canvasToBlob(canvas, 'image/webp', 0.95);
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
