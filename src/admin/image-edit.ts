// In-memory edit state per image id, fetch/save against the server
// or queue offline. Pure mutators live in src/lib/image-edit-ops.ts.

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
    sourceHeight: s.sourceHeight
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
    sourceHeight: meta.height
  };
  localEditState.set(id, fresh);
  persistImageState(id, fresh);
  return fresh;
}

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

export async function saveImageEdits(id: string, s: LocalEditState): Promise<void> {
  if (getState() !== 'offline') {
    try {
      await commitOnline(id, s);
      s.baseline = { ops: [...s.ops], redoStack: [...s.redoStack] };
      persistImageState(id, s);
      return;
    } catch (err) {
      // /ops may have landed but /bake failed; the public site
      // mustn't serve 500s for ops without a bake — roll /ops back
      // to baseline before falling through to the offline queue.
      await postOpsToServer(id, [...s.baseline.ops], [...s.baseline.redoStack]).catch(() => {
        /* fall through */
      });
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
  // setOps before bake matches the online order — server unlinks
  // the bake on ops change.
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
