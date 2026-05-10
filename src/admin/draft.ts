// Editor draft persistence to OPFS (spec-offline §7). Single-draft
// session today; multi-draft list lands when phase 2 pinning grows
// past the storage panel's needs.

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
  /** Server-side updated_at as of the last sync. Echoed back as
   * X-Rkr-Last-Synced-At for the optimistic-concurrency check. */
  lastSyncedAt?: string;
  /** Drives the 7-day cached-eviction TTL. */
  lastAccessedAt: string;
  /** "pinned" survives eviction. Default "cached". */
  mode?: 'cached' | 'pinned';
  /** Image ids referenced by the draft body. Eviction's reference
   * set is the union over surviving metas; absent → keep all. */
  refIds?: string[];
}

/** @public */
export async function getOrCreateDraftId(): Promise<string> {
  const root = await readRoot();
  /* v8 ignore next 3 -- ensureSchema runs first */
  if (!root) {
    throw new Error('draft: _root.json missing — ensureSchema not called?');
  }
  if (root.currentDraftId) return root.currentDraftId;
  const draftId = crypto.randomUUID();
  await writeRoot({ ...root, currentDraftId: draftId });
  return draftId;
}

export async function loadDraft(draftId: string): Promise<unknown | null> {
  return readJson(`${DRAFT_DIR}/${draftId}.json`);
}

/** @public */
export async function readMeta(draftId: string): Promise<DraftMeta | null> {
  return readJson<DraftMeta>(`${META_DIR}/${draftId}.json`);
}

/** @public */
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

/** @public */
export function startDraftPersistence(editor: Editor, draftId: string): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null;

  const flush = async (): Promise<void> => {
    pending = null;
    const json = editor.getJSON();
    await writeJson(`${DRAFT_DIR}/${draftId}.json`, json);
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

  // Heartbeat bumps lastAccessedAt as well as the lock file: OPFS
  // readJson can't distinguish ENOENT from parse error, so a torn
  // lock read could otherwise treat a live draft as unlocked.
  const beat = async (): Promise<void> => {
    await writeJson(`${DRAFT_DIR}/${draftId}.lock`, { ts: Date.now() });
    await updateMeta(draftId, { lastAccessedAt: new Date().toISOString() });
  };
  void beat();
  const heartbeat = setInterval(() => {
    void beat();
  }, HEARTBEAT_MS);

  return () => {
    /* v8 ignore start -- SPA mounts once and never tears down */
    clearInterval(heartbeat);
    if (pending !== null) {
      clearTimeout(pending);
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

/** @public */
export async function clearDraft(draftId: string): Promise<void> {
  /* v8 ignore start -- callers land in phase 2 + phase 3 */
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
