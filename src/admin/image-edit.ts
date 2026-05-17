// In-memory edit state per image id, fetch/save against the server
// or queue offline. Pure mutators live in src/lib/image-edit-ops.ts.

import { isDirty, type LocalEditState } from '../lib/image-edit-ops.ts';
import { validateOps } from '../lib/ops-validation.ts';
import type { SidecarOp } from '../lib/sidecar-types.ts';
import { canvasToBlob, getPipelineCache, loadOriginal } from './canvas-loaders';
import { setStatus } from './dom.ts';
import { getState } from './online-state.ts';
import { readJson, removeFile, writeJson } from './opfs.ts';
import { OPFS_DIRS } from './opfs-schema.ts';
import { append as outboxAppend } from './outbox.ts';
import { onImageStateInvalidated, publishImageStateInvalidation, tryDrain } from './sync.ts';

const IMAGE_STATE_DIR = OPFS_DIRS.IMAGE_STATE;

interface PersistedImageState {
  schemaVersion: 1;
  id: string;
  ops: SidecarOp[];
  redoStack: SidecarOp[];
  baseline: { ops: SidecarOp[]; redoStack: SidecarOp[] };
  sourceWidth: number | null;
  sourceHeight: number | null;
  /** Edit-start sidecar updated_at for the commit guard. Optional so
   * snapshots written before this field still load. */
  sidecarBase?: string;
}

/** Fire-and-forget persist so a tab reload restores unsaved edits.
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
    sourceHeight: s.sourceHeight,
    sidecarBase: s.sidecarBase
  };
  void writeJson(`${IMAGE_STATE_DIR}/${id}.json`, snapshot).catch((err) => {
    /* v8 ignore next 2 -- best-effort write */
    console.warn(`persistImageState ${id}:`, err);
  });
}

async function loadImageState(id: string): Promise<LocalEditState | null> {
  const raw = await readJson<PersistedImageState>(`${IMAGE_STATE_DIR}/${id}.json`);
  /* v8 ignore next -- absent-file is the no-cache case */
  if (!raw) return null;
  return {
    ops: raw.ops,
    redoStack: raw.redoStack,
    baseline: raw.baseline,
    sourceWidth: raw.sourceWidth,
    sourceHeight: raw.sourceHeight,
    sidecarBase: raw.sidecarBase
  };
}

interface SidecarMeta {
  width: number | null;
  height: number | null;
  format: string | null;
  ops: SidecarOp[];
  redoStack: SidecarOp[];
  /** Sidecar updated_at; adopted as the edit-start guard baseline. */
  updatedAt: string | null;
}

async function fetchSidecarMeta(id: string): Promise<SidecarMeta> {
  const res = await fetch(`/admin/sidecar/${id}/meta`);
  if (!res.ok) throw new Error(`meta: ${res.status}`);
  return (await res.json()) as SidecarMeta;
}

const localEditState = new Map<string, LocalEditState>();

// Cross-tab cache invalidation: another tab just drained a commit
// for this id, so the server has moved on. Drop our cached state
// so the next access refetches the fresh baseline from the server.
// Skip when the local tab has unsaved edits — clobbering live work
// would be worse than the stale-cache risk; the user gets a warning
// instead and can resolve by saving (last-write-wins) or reloading.
onImageStateInvalidated((id) => {
  const s = localEditState.get(id);
  if (s && isDirty(s)) {
    setStatus(`image ${id.slice(0, 8)}… diverged in another tab; save or reload to merge`);
    return;
  }
  localEditState.delete(id);
  void removeFile(`${IMAGE_STATE_DIR}/${id}.json`);
});

export function getLocalEditState(id: string): LocalEditState | undefined {
  return localEditState.get(id);
}

/** Lookup order: in-process Map → OPFS persist → server fetch. */
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
    sourceHeight: meta.height,
    // Edit-start baseline for the commit optimistic-concurrency
    // guard (mirrors save.ts seeding lastSyncedAt from meta).
    sidecarBase: meta.updatedAt ?? undefined
  };
  localEditState.set(id, fresh);
  persistImageState(id, fresh);
  return fresh;
}

/** Build the multipart payload for POST /admin/sidecar/:id/commit.
 * One `ops` text part (JSON ops + redoStack); one `bake` file part
 * iff ops is non-empty. The server validates both, normalizes ops,
 * and writes the bake + sidecar back-to-back. Returns the normalized
 * form so the caller can adopt it as authoritative. */
async function postCommit(
  id: string,
  ops: SidecarOp[],
  redoStack: SidecarOp[],
  bake: Blob | null
): Promise<{ ops: SidecarOp[]; redoStack: SidecarOp[]; updatedAt: string | null }> {
  const fd = new FormData();
  fd.append('ops', JSON.stringify({ ops, redoStack }));
  if (bake) fd.append('bake', bake, `${id}.webp`);
  const res = await fetch(`/admin/sidecar/${id}/commit`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`commit: ${res.status} ${await res.text()}`);
  return (await res.json()) as {
    ops: SidecarOp[];
    redoStack: SidecarOp[];
    updatedAt: string | null;
  };
}

export async function saveImageEdits(id: string, s: LocalEditState): Promise<void> {
  // Client-side validateOps so the bake's pixels match the ops the
  // server will store. Falls through to the server's validateOps on
  // failure (which returns 400 with a usable error string).
  const dims = { width: s.sourceWidth ?? 0, height: s.sourceHeight ?? 0 };
  const v = validateOps(s.ops, dims);
  if (v.ok) s.ops = v.ops;
  const rs = validateOps(s.redoStack, dims);
  if (rs.ok) s.redoStack = rs.ops;

  const bake = s.ops.length > 0 ? await renderBakeBlob(id, s.ops) : null;

  if (getState() !== 'offline') {
    try {
      const normalized = await postCommit(id, s.ops, s.redoStack, bake);
      s.ops = normalized.ops;
      s.redoStack = normalized.redoStack;
      s.baseline = { ops: [...s.ops], redoStack: [...s.redoStack] };
      // Re-anchor the guard baseline to the sidecar's new
      // updated_at so the next edit's commit compares against this
      // write, not a stale pre-edit value (mirrors save.ts adopting
      // result.updatedAt as the next lastSyncedAt).
      if (normalized.updatedAt) s.sidecarBase = normalized.updatedAt;
      persistImageState(id, s);
      // Server's state moved on. Tell other tabs to drop their
      // cached state for this id so their next save doesn't clobber.
      publishImageStateInvalidation(id);
      return;
    } catch (err) {
      console.warn('saveImageEdits online failed, queueing offline:', err);
    }
  }

  await outboxAppend(
    {
      op: 'commitImageEdit',
      payload: {
        id,
        ops: [...s.ops],
        redoStack: [...s.redoStack],
        hasBake: bake !== null,
        sidecarBase: s.sidecarBase
      }
    },
    bake ?? undefined
  );
  s.baseline = { ops: [...s.ops], redoStack: [...s.redoStack] };
  persistImageState(id, s);
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

export function dirtyImageStates(): Array<[string, LocalEditState]> {
  const out: Array<[string, LocalEditState]> = [];
  for (const [id, s] of localEditState) {
    if (isDirty(s)) out.push([id, s]);
  }
  return out;
}

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
