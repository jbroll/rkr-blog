// Pure eviction-policy planner. Takes a snapshot of OPFS state +
// `now`, returns the set of drafts + originals to delete. Lives in
// src/lib so c8 can measure it; the OPFS-coupled side (file deletion,
// listDir traversal) lives in src/admin/eviction.ts.
//
// Spec-offline.md §7:
//   1. For each meta with mode === 'cached' AND lastAccessedAt <
//      now - 7d AND no fresh lock: evict the draft + meta + image-
//      state files whose id is referenced ONLY by this draft.
//   2. After cached evictions, walk surviving metas, compute the
//      union of their refIds.
//   3. For each id under originals/: if id not in the union, evict
//      original + sidecar + bake.

/** @public */
export interface MetaSnapshot {
  draftId: string;
  mode?: 'cached' | 'pinned';
  lastAccessedAt: string;
  refIds?: string[];
  /** ms-since-epoch of the latest heartbeat lock for this draft, or
   * null if no lock present. A lock newer than `now - lockGraceMs`
   * means the draft is in active use and can't be evicted even if
   * lastAccessedAt is older than the TTL. */
  lockTs: number | null;
}

/** @public */
export interface EvictionPlan {
  evictDrafts: string[];
  evictOriginals: string[];
  /** Image-state files whose draft owners are being evicted AND no
   * surviving draft references the same id. Caller deletes
   * `image-state/<id>.json` for each. */
  evictImageStates: string[];
}

/** @public */
export interface EvictionInput {
  metas: readonly MetaSnapshot[];
  /** All ids present under opfs://originals/. */
  originalsIds: readonly string[];
  /** All ids present under opfs://image-state/. Used to scope
   * orphan-cleanup to files actually on disk. */
  imageStateIds: readonly string[];
  now: number;
  ttlDays?: number;
  lockGraceMs?: number;
}

const DEFAULT_TTL_DAYS = 7;
const DEFAULT_LOCK_GRACE_MS = 60_000;

/** Compute the eviction plan. Pure: same input → same output. */
export function planEviction(input: EvictionInput): EvictionPlan {
  const ttlDays = input.ttlDays ?? DEFAULT_TTL_DAYS;
  const lockGraceMs = input.lockGraceMs ?? DEFAULT_LOCK_GRACE_MS;
  const cutoff = input.now - ttlDays * 24 * 60 * 60 * 1000;

  const evictDrafts: string[] = [];
  const surviving: MetaSnapshot[] = [];
  for (const m of input.metas) {
    const mode = m.mode ?? 'cached';
    const isLocked = m.lockTs !== null && m.lockTs > input.now - lockGraceMs;
    // TTL boundary: lastAccessedAt strictly older than `cutoff` is
    // stale. Equality (lastAccessedAt === cutoff) is NOT stale —
    // grace-of-one-tick to favour the user.
    const isStale = Date.parse(m.lastAccessedAt) < cutoff;
    if (mode === 'cached' && isStale && !isLocked) {
      evictDrafts.push(m.draftId);
    } else {
      surviving.push(m);
    }
  }

  // Reference set: union of refIds across surviving drafts.
  const referenced = new Set<string>();
  for (const m of surviving) {
    for (const id of m.refIds ?? []) referenced.add(id);
  }

  // Bootstrap-safety: when there are NO surviving metas (fresh
  // install, every cached draft just expired, or pre-pin first
  // mount with stale leftovers from another session), `referenced`
  // is empty and every original / image-state would otherwise look
  // orphaned. Skip the orphan sweep in that case — the user might
  // be about to pin a post, and yanking originals before they get
  // a chance to mount the draft would force a re-fetch from the
  // server. Originals only get reclaimed when at least one draft
  // survives to vouch for the reference set.
  const haveReferenceSet = surviving.length > 0;
  const evictOriginals = haveReferenceSet
    ? input.originalsIds.filter((id) => !referenced.has(id))
    : [];
  const evictImageStates = haveReferenceSet
    ? input.imageStateIds.filter((id) => !referenced.has(id))
    : [];

  return { evictDrafts, evictOriginals, evictImageStates };
}
