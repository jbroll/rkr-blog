// OPFS-side eviction. Pure planner: src/lib/eviction-pure.ts.

import { type EvictionPlan, type MetaSnapshot, planEviction } from '../lib/eviction-pure.ts';
import { splitIds } from '../lib/figure-ids.ts';
import { markdownToProse, type ProseDoc } from '../lib/prose-markdown.ts';
import { listDir, readJson, removeFile } from './opfs.ts';
import { OPFS_DIRS } from './opfs-schema.ts';
import { list as outboxList } from './outbox.ts';

const DRAFTS_DIR = OPFS_DIRS.DRAFTS;
const META_DIR = OPFS_DIRS.META;
const ORIGINALS_DIR = OPFS_DIRS.ORIGINALS;
const SIDECARS_DIR = OPFS_DIRS.SIDECARS;
const IMAGE_STATE_DIR = OPFS_DIRS.IMAGE_STATE;
const BAKES_DIR = OPFS_DIRS.BAKES;

interface PersistedMeta {
  schemaVersion: number;
  draftId: string;
  slug?: string;
  mode?: 'cached' | 'pinned';
  lastAccessedAt: string;
  refIds?: string[];
}

/** Ids that the planner sees as orphans (no surviving meta lists
 * them) but are actually still in active use this instant — either
 * because the upload hasn't drained yet (debounce on draft-meta
 * persist hasn't fired) or the editor's DOM still holds an `<img>`
 * referencing them. Without this guard, runEviction fires on
 * `onAfterDrainEmpty` and can delete originals/<id> before the
 * 500 ms refIds-persist debounce updates the draft meta —
 * regression introduced by local-first uploads (drain triggers
 * eviction; pre-local-first uploads never queued so eviction never
 * ran for fresh inserts). */
async function collectLiveRefIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  // 1. Outbox-pending uploads: drain might be in-flight; the file
  //    is still load-bearing for the figure thumb. savePost entries:
  //    an inserted image's upload entry may have already drained
  //    (marker cleared) while the post itself is still unsynced — the
  //    originals it references stay load-bearing until savePost drains.
  for (const entry of await outboxList()) {
    if (entry.op === 'upload') {
      ids.add(entry.payload.id);
    } else if (entry.op === 'savePost') {
      for (const id of figureIdsInMarkdown(entry.payload.markdown)) ids.add(id);
    }
  }
  // 2. Live editor DOM: the persist debounce may not have written
  //    a fresh refIds yet, but every <img data-id> on the page is
  //    by definition in use right now.
  if (typeof document !== 'undefined') {
    for (const img of document.querySelectorAll<HTMLImageElement>('img.rkr-image[data-id]')) {
      const id = img.dataset.id;
      if (id) ids.add(id);
    }
  }
  return ids;
}

/** Figure ids referenced by a savePost payload's markdown. Parses
 * via the shared markdown→prose pipeline (no regex over the wire
 * format) and splits each figure's `ids` with the canonical
 * figure-ids splitter — same shape as draft.ts refIdsFromDoc. */
function figureIdsInMarkdown(markdown: string): string[] {
  const out: string[] = [];
  const stack: ProseDoc['content'] = [markdownToProse(markdown)];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === 'figure') {
      const raw = (node.attrs as { ids?: string } | undefined)?.ids;
      out.push(...splitIds(raw));
    }
    if (node.content) stack.push(...node.content);
  }
  return out;
}

/** @public */
export async function runEviction(now: number = Date.now()): Promise<EvictionPlan> {
  const metas = await collectMetas();
  const originalsIds = await collectOriginals();
  const imageStateIds = await collectImageStateIds();

  const plan = planEviction({ metas, originalsIds, imageStateIds, now });
  const liveRefs = await collectLiveRefIds();
  // Filter the planner's evict lists through live refs so a fresh
  // upload (drain just finished; draft-persist debounce not yet
  // fired) survives. evictDrafts is left alone — drafts are keyed
  // on their own ids, not image ids, and the lock-grace already
  // protects live drafts.
  const evictOriginals = plan.evictOriginals.filter((id) => !liveRefs.has(id));
  const evictImageStates = plan.evictImageStates.filter((id) => !liveRefs.has(id));

  for (const draftId of plan.evictDrafts) {
    await removeFile(`${DRAFTS_DIR}/${draftId}.json`).catch(() => {});
    await removeFile(`${DRAFTS_DIR}/${draftId}.lock`).catch(() => {});
    await removeFile(`${META_DIR}/${draftId}.json`).catch(() => {});
  }
  for (const id of evictOriginals) {
    // Plan carries ids; originals/<id>.<ext> needs prefix-walking.
    for (const fname of await listDir(ORIGINALS_DIR)) {
      if (fname.startsWith(`${id}.`)) {
        await removeFile(`${ORIGINALS_DIR}/${fname}`).catch(() => {});
      }
    }
    await removeFile(`${SIDECARS_DIR}/${id}.json`).catch(() => {});
    await removeFile(`${BAKES_DIR}/${id}.webp`).catch(() => {});
  }
  for (const id of evictImageStates) {
    await removeFile(`${IMAGE_STATE_DIR}/${id}.json`).catch(() => {});
  }
  return { evictDrafts: plan.evictDrafts, evictOriginals, evictImageStates };
}

async function collectMetas(): Promise<MetaSnapshot[]> {
  const out: MetaSnapshot[] = [];
  for (const fname of await listDir(META_DIR)) {
    // _root.json lives in meta/ too; it's not a draft meta.
    if (!fname.endsWith('.json') || fname === '_root.json') continue;
    // Read lock BEFORE meta. The eviction planner survives a draft
    // when EITHER signal is fresh; reading the lock first means a
    // concurrent heartbeat (lock then meta) gives us at-worst a
    // pre-heartbeat lock paired with a post-heartbeat meta — both
    // freshness signals, neither ever older than the other read's
    // timestamp.
    const draftId = fname.slice(0, -'.json'.length);
    const lock = await readJson<{ ts: number }>(`${DRAFTS_DIR}/${draftId}.lock`);
    const m = await readJson<PersistedMeta>(`${META_DIR}/${fname}`);
    /* v8 ignore next -- malformed-on-disk path */
    if (!m) continue;
    out.push({
      draftId: m.draftId,
      mode: m.mode,
      lastAccessedAt: m.lastAccessedAt,
      refIds: m.refIds,
      lockTs: lock?.ts ?? null
    });
  }
  return out;
}

async function collectOriginals(): Promise<string[]> {
  const ids: string[] = [];
  for (const fname of await listDir(ORIGINALS_DIR)) {
    const dot = fname.lastIndexOf('.');
    /* v8 ignore next -- ext-less files shouldn't appear */
    if (dot <= 0) continue;
    ids.push(fname.slice(0, dot));
  }
  return ids;
}

async function collectImageStateIds(): Promise<string[]> {
  const ids: string[] = [];
  for (const fname of await listDir(IMAGE_STATE_DIR)) {
    /* v8 ignore next -- non-json files filtered out */
    if (!fname.endsWith('.json')) continue;
    ids.push(fname.slice(0, -5));
  }
  return ids;
}
