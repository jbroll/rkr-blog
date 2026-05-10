// OPFS-side wiring for the eviction policy. Pure planner lives in
// src/lib/eviction-pure.ts; this module collects the snapshot from
// disk, hands it to the planner, and applies the resulting deletes.
//
// Spec-offline §7: eviction runs on every editor mount AND after a
// drain that returns the queue to empty. Both call sites just
// invoke runEviction() — no external coordination needed since OPFS
// is per-origin and a single tab is the leader (phase 1d).

import { type EvictionPlan, type MetaSnapshot, planEviction } from '../lib/eviction-pure.ts';
import { listDir, readJson, removeFile } from './opfs.ts';

const DRAFTS_DIR = 'drafts';
const META_DIR = 'meta';
const ORIGINALS_DIR = 'originals';
const SIDECARS_DIR = 'sidecars';
const IMAGE_STATE_DIR = 'image-state';
const BAKES_DIR = 'bakes';

interface PersistedMeta {
  schemaVersion: number;
  draftId: string;
  slug?: string;
  mode?: 'cached' | 'pinned';
  lastAccessedAt: string;
  refIds?: string[];
}

/** Run one eviction pass. Returns counts so callers (status panel,
 * tests) can surface what happened. Failures inside the OPFS
 * deletes are swallowed — the next pass picks them up.
 * @public */
export async function runEviction(now: number = Date.now()): Promise<EvictionPlan> {
  const metas = await collectMetas();
  const originalsIds = await collectOriginals();
  const imageStateIds = await collectImageStateIds();

  const plan = planEviction({ metas, originalsIds, imageStateIds, now });

  for (const draftId of plan.evictDrafts) {
    await removeFile(`${DRAFTS_DIR}/${draftId}.json`).catch(() => {});
    await removeFile(`${DRAFTS_DIR}/${draftId}.lock`).catch(() => {});
    await removeFile(`${META_DIR}/${draftId}.json`).catch(() => {});
  }
  for (const id of plan.evictOriginals) {
    // The on-disk filename includes the extension; we don't have it
    // in the plan (which is just ids). Walk the originals/ dir for
    // matching prefix.
    for (const fname of await listDir(ORIGINALS_DIR)) {
      if (fname.startsWith(`${id}.`)) {
        await removeFile(`${ORIGINALS_DIR}/${fname}`).catch(() => {});
      }
    }
    await removeFile(`${SIDECARS_DIR}/${id}.json`).catch(() => {});
    await removeFile(`${BAKES_DIR}/${id}.webp`).catch(() => {});
  }
  for (const id of plan.evictImageStates) {
    await removeFile(`${IMAGE_STATE_DIR}/${id}.json`).catch(() => {});
  }
  return plan;
}

async function collectMetas(): Promise<MetaSnapshot[]> {
  const out: MetaSnapshot[] = [];
  for (const fname of await listDir(META_DIR)) {
    // _root.json lives in meta/ too; it's not a draft meta.
    if (!fname.endsWith('.json') || fname === '_root.json') continue;
    const m = await readJson<PersistedMeta>(`${META_DIR}/${fname}`);
    /* v8 ignore next -- malformed file on disk; the read returns null */
    if (!m) continue;
    const lock = await readJson<{ ts: number }>(`${DRAFTS_DIR}/${m.draftId}.lock`);
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
    // Filenames are <id>.<ext>; strip the ext.
    const dot = fname.lastIndexOf('.');
    /* v8 ignore next -- ext-less files shouldn't appear; defensive */
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
