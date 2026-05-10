// Draft persistence — keeps the TipTap editor's working document in
// OPFS so a tab close + reopen restores exactly what the author saw
// last (spec-offline.md §7). The editor is the single user-facing
// surface; without persistence, an offline crash silently loses
// in-progress text.
//
// Single-draft session model for phase 1h: the active draftId is
// stored in _root.json#currentDraftId. Mount picks it up (or
// generates one), restores `drafts/<id>.json` if present, and wires:
//
//   • debounced 500ms persistence on every editor `update` event,
//   • a 30s heartbeat to `drafts/<id>.lock` so the eviction policy
//     (spec-offline §7) can tell "this draft is in active use" from
//     "this draft is stale and reclaim-eligible".
//
// Phase 2 introduces multi-draft + pinning; the JSON shapes here are
// already aligned (`draftId`, `slug`, `lastSyncedAt`, `lastAccessedAt`)
// so phase 2 is purely additive — no schema bump.

import type { Editor } from '@tiptap/core';

import { readJson, removeFile, writeJson } from './opfs.ts';
import { readRoot, writeRoot } from './opfs-schema.ts';

const DRAFT_DIR = 'drafts';
const META_DIR = 'meta';
const HEARTBEAT_MS = 30_000;
const DEBOUNCE_MS = 500;

interface DraftMeta {
  schemaVersion: 1;
  draftId: string;
  slug?: string;
  /** Server's `updated_at` at the time of the last successful pull
   * (or last successful savePost drain). Echoed back as the
   * X-Rkr-Last-Synced-At header so the server can detect concurrent
   * edits. Phase 1k populates this on save success. */
  lastSyncedAt?: string;
  /** Most recent local edit time. Drives 7-day cached eviction. */
  lastAccessedAt: string;
  /** "pinned" survives eviction; "cached" is reclaim-eligible after
   * 7 days idle (spec-offline §7). Defaults to "cached" — phase 2's
   * pin flow flips it to "pinned". */
  mode?: 'cached' | 'pinned';
  /** Image ids the post body references. Used by the eviction
   * policy to determine which originals/sidecars are still needed
   * across the surviving meta set. Pin populates this from the
   * bundle manifest; fresh drafts populate as figures are inserted. */
  refIds?: string[];
}

/** Get the active draft id, creating one if absent. Stored in
 * _root.json#currentDraftId — single-draft semantics for phase 1h.
 * @public */
export async function getOrCreateDraftId(): Promise<string> {
  const root = await readRoot();
  /* v8 ignore next 3 -- ensureSchema runs first; missing-root would
     mean a corrupted OPFS, not a normal flow */
  if (!root) {
    throw new Error('draft: _root.json missing — ensureSchema not called?');
  }
  if (root.currentDraftId) return root.currentDraftId;
  const draftId = crypto.randomUUID();
  await writeRoot({ ...root, currentDraftId: draftId });
  return draftId;
}

/** Read a previously-persisted draft's TipTap JSON. Returns null
 * when no draft exists for this id (fresh editor). Caller is the
 * mount path in startup.ts. */
export async function loadDraft(draftId: string): Promise<unknown | null> {
  return readJson(`${DRAFT_DIR}/${draftId}.json`);
}

/** Read the draft's metadata sidecar. save.ts uses this to populate
 * the X-Rkr-Last-Synced-At header on outgoing savePost entries.
 * @public */
export async function readMeta(draftId: string): Promise<DraftMeta | null> {
  return readJson<DraftMeta>(`${META_DIR}/${draftId}.json`);
}

/** Merge a partial update into the draft's meta sidecar. Phase 1k
 * uses this from save.ts to record the server-side updated_at.
 * Phase 1h itself only stamps lastAccessedAt on each flush.
 * @public */
export async function updateMeta(
  draftId: string,
  patch: Partial<Omit<DraftMeta, 'schemaVersion' | 'draftId'>>
): Promise<void> {
  const existing = (await readMeta(draftId)) ?? {
    schemaVersion: 1 as const,
    draftId,
    lastAccessedAt: new Date().toISOString()
  };
  const next: DraftMeta = {
    ...existing,
    ...patch,
    lastAccessedAt: patch.lastAccessedAt ?? new Date().toISOString()
  };
  await writeJson(`${META_DIR}/${draftId}.json`, next);
}

/** Wire 500ms-debounced persistence of editor JSON + 30s heartbeat
 * on `drafts/<id>.lock`. Returns a cleanup fn the SPA retains for
 * its lifetime — no caller currently invokes it (the heartbeat ends
 * when the tab closes), but the shape supports a future "logout
 * clears local state" button without restructuring.
 * @public */
export function startDraftPersistence(editor: Editor, draftId: string): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null;

  const flush = async (): Promise<void> => {
    pending = null;
    const json = editor.getJSON();
    await writeJson(`${DRAFT_DIR}/${draftId}.json`, json);
    // Scan for figure-node ids so eviction (phase 3) knows which
    // originals/sidecars/image-state files this draft pins. Without
    // refIds the eviction planner can't tell orphaned files from
    // ones the draft still needs, so it defaults to keeping
    // everything.
    await updateMeta(draftId, {
      lastAccessedAt: new Date().toISOString(),
      refIds: refIdsFromDoc(json)
    });
  };

  const onUpdate = (): void => {
    /* v8 ignore next -- timer-clear race; harmless to skip */
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      void flush();
    }, DEBOUNCE_MS);
  };
  editor.on('update', onUpdate);

  // Heartbeat: rewrite the lock file every 30s + bump
  // lastAccessedAt. Eviction (phase 3) treats lock ts < now-60s as
  // stale; updating lastAccessedAt too means a torn lock-file read
  // (OPFS readJson returns null for both ENOENT and parse errors)
  // is shadowed by the freshness check on lastAccessedAt — a
  // currently-edited draft survives even if its lock file is
  // momentarily unreadable.
  const beat = async (): Promise<void> => {
    await writeJson(`${DRAFT_DIR}/${draftId}.lock`, { ts: Date.now() });
    await updateMeta(draftId, { lastAccessedAt: new Date().toISOString() });
  };
  void beat();
  const heartbeat = setInterval(() => {
    void beat();
  }, HEARTBEAT_MS);

  return () => {
    /* v8 ignore start -- cleanup path runs on logout/unmount; phase 1h
       SPA mounts once and never tears down */
    clearInterval(heartbeat);
    if (pending !== null) {
      clearTimeout(pending);
      // Final flush so the last edits aren't lost on graceful unmount.
      void flush().catch(() => {});
    }
    editor.off('update', onUpdate);
    /* v8 ignore stop */
  };
}

interface RefIdScanNode {
  type?: string;
  attrs?: { ids?: string };
  content?: RefIdScanNode[];
}

/** Walk a TipTap JSON doc, collecting the comma-separated ids on
 * each figure node. Pure: tested via the eviction-pure unit suite
 * indirectly (a draft persisted with images then reloaded must
 * survive eviction). */
function refIdsFromDoc(doc: unknown): string[] {
  const ids = new Set<string>();
  const stack: RefIdScanNode[] = [doc as RefIdScanNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === 'figure' && typeof node.attrs?.ids === 'string') {
      for (const id of node.attrs.ids.split(',')) {
        const trimmed = id.trim();
        if (trimmed) ids.add(trimmed);
      }
    }
    if (Array.isArray(node.content)) {
      for (const c of node.content) stack.push(c);
    }
  }
  return [...ids];
}

/** Drop a draft from OPFS. Used when the author starts a new post
 * (clears currentDraftId so the next mount starts fresh). Phase 3
 * eviction calls this for evict-eligible cached drafts.
 * @public */
export async function clearDraft(draftId: string): Promise<void> {
  /* v8 ignore start -- consumers land in phase 2 (pinning) + phase 3
     (eviction); single-draft session today never clears */
  await removeFile(`${DRAFT_DIR}/${draftId}.json`);
  await removeFile(`${DRAFT_DIR}/${draftId}.lock`);
  await removeFile(`${META_DIR}/${draftId}.json`);
  const root = await readRoot();
  if (root?.currentDraftId === draftId) {
    const { currentDraftId: _drop, ...rest } = root;
    await writeRoot(rest);
  }
  /* v8 ignore stop */
}
