// Pure eviction-policy planner (spec-offline §7). Pure split from
// src/admin/eviction.ts so c8 can measure it.

/** @public */
export interface MetaSnapshot {
  draftId: string;
  mode?: 'cached' | 'pinned';
  lastAccessedAt: string;
  refIds?: string[];
  /** ms-since-epoch of the latest heartbeat lock, or null if no
   * lock file present. Fresher than `now - lockGraceMs` blocks
   * eviction even when lastAccessedAt is past the TTL. */
  lockTs: number | null;
}

/** @public */
export interface EvictionPlan {
  evictDrafts: string[];
  evictOriginals: string[];
  evictImageStates: string[];
}

/** @public */
export interface EvictionInput {
  metas: readonly MetaSnapshot[];
  originalsIds: readonly string[];
  imageStateIds: readonly string[];
  now: number;
  ttlDays?: number;
  lockGraceMs?: number;
}

const DEFAULT_TTL_DAYS = 7;
/** Heartbeat freshness window. A lock newer than now-LOCK_GRACE_MS
 * blocks eviction. Must stay >= 2 × draft.ts:HEARTBEAT_MS so a
 * single missed beat doesn't booby-trap a live draft.
 * @public */
export const LOCK_GRACE_MS = 60_000;

export function planEviction(input: EvictionInput): EvictionPlan {
  const ttlDays = input.ttlDays ?? DEFAULT_TTL_DAYS;
  const lockGraceMs = input.lockGraceMs ?? LOCK_GRACE_MS;
  const cutoff = input.now - ttlDays * 24 * 60 * 60 * 1000;

  const evictDrafts: string[] = [];
  const surviving: MetaSnapshot[] = [];
  for (const m of input.metas) {
    const mode = m.mode ?? 'cached';
    const isLocked = m.lockTs !== null && m.lockTs > input.now - lockGraceMs;
    // Strict `<` favours the user on the TTL boundary.
    const isStale = Date.parse(m.lastAccessedAt) < cutoff;
    if (mode === 'cached' && isStale && !isLocked) {
      evictDrafts.push(m.draftId);
    } else {
      surviving.push(m);
    }
  }

  const referenced = new Set<string>();
  for (const m of surviving) {
    for (const id of m.refIds ?? []) referenced.add(id);
  }

  // Bootstrap-safety: with NO metas at all (fresh install, never
  // pinned), every original looks orphaned. Keep them until at
  // least one meta exists. When metas exist but all happened to
  // expire this round, orphan-cleanup IS desired — the user's
  // drafts are gone, the originals they referenced should follow.
  const haveAnyMetas = input.metas.length > 0;
  const evictOriginals = haveAnyMetas ? input.originalsIds.filter((id) => !referenced.has(id)) : [];
  const evictImageStates = haveAnyMetas
    ? input.imageStateIds.filter((id) => !referenced.has(id))
    : [];

  return { evictDrafts, evictOriginals, evictImageStates };
}
