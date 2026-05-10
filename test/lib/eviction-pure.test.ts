import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planEviction } from '../../src/lib/eviction-pure.ts';

const NOW = Date.parse('2026-05-10T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

test('planEviction: cached drafts older than TTL → evicted; pinned untouched', () => {
  const plan = planEviction({
    metas: [
      {
        draftId: 'old-cached',
        mode: 'cached',
        lastAccessedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        lockTs: null
      },
      {
        draftId: 'old-pinned',
        mode: 'pinned',
        lastAccessedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
        lockTs: null
      },
      {
        draftId: 'fresh',
        mode: 'cached',
        lastAccessedAt: new Date(NOW - 1 * DAY_MS).toISOString(),
        lockTs: null
      }
    ],
    originalsIds: [],
    imageStateIds: [],
    now: NOW
  });
  assert.deepEqual(plan.evictDrafts, ['old-cached']);
});

test('planEviction: defaults mode = cached when omitted', () => {
  const plan = planEviction({
    metas: [
      {
        draftId: 'no-mode',
        lastAccessedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
        lockTs: null
      }
    ],
    originalsIds: [],
    imageStateIds: [],
    now: NOW
  });
  assert.deepEqual(plan.evictDrafts, ['no-mode']);
});

test('planEviction: fresh lock blocks eviction even if lastAccessedAt is stale', () => {
  const plan = planEviction({
    metas: [
      {
        draftId: 'in-use',
        mode: 'cached',
        lastAccessedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
        lockTs: NOW - 5_000
      }
    ],
    originalsIds: [],
    imageStateIds: [],
    now: NOW
  });
  assert.deepEqual(plan.evictDrafts, []);
});

test('planEviction: stale lock (older than 60s) doesn’t block eviction', () => {
  const plan = planEviction({
    metas: [
      {
        draftId: 'abandoned',
        mode: 'cached',
        lastAccessedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
        lockTs: NOW - 5 * 60_000
      }
    ],
    originalsIds: [],
    imageStateIds: [],
    now: NOW
  });
  assert.deepEqual(plan.evictDrafts, ['abandoned']);
});

test('planEviction: originals not referenced by surviving drafts → evicted', () => {
  const plan = planEviction({
    metas: [
      {
        draftId: 'survives',
        mode: 'pinned',
        lastAccessedAt: new Date(NOW).toISOString(),
        refIds: ['keep1', 'keep2'],
        lockTs: null
      }
    ],
    originalsIds: ['keep1', 'keep2', 'orphan-a', 'orphan-b'],
    imageStateIds: [],
    now: NOW
  });
  assert.deepEqual(plan.evictOriginals.sort(), ['orphan-a', 'orphan-b']);
});

test('planEviction: shared originals across pinned + cached survive when both referenced', () => {
  const plan = planEviction({
    metas: [
      {
        draftId: 'pinned-a',
        mode: 'pinned',
        lastAccessedAt: new Date(NOW).toISOString(),
        refIds: ['shared'],
        lockTs: null
      },
      {
        draftId: 'pinned-b',
        mode: 'pinned',
        lastAccessedAt: new Date(NOW).toISOString(),
        refIds: ['shared', 'pinned-only'],
        lockTs: null
      }
    ],
    originalsIds: ['shared', 'pinned-only'],
    imageStateIds: [],
    now: NOW
  });
  assert.deepEqual(plan.evictOriginals, []);
});

test('planEviction: cached eviction with a surviving meta drops orphaned originals', () => {
  // The previous "cached cascade" case is now split: orphan-cleanup
  // requires at least one surviving meta to vouch for the reference
  // set, so this test keeps a pinned draft alongside the evicted
  // cached one. Without the pinned meta the bootstrap-safety branch
  // (covered by the next test) keeps everything.
  const plan = planEviction({
    metas: [
      {
        draftId: 'evicted',
        mode: 'cached',
        lastAccessedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
        refIds: ['only-in-evicted'],
        lockTs: null
      },
      {
        draftId: 'pinned',
        mode: 'pinned',
        lastAccessedAt: new Date(NOW).toISOString(),
        refIds: ['kept-by-pinned'],
        lockTs: null
      }
    ],
    originalsIds: ['only-in-evicted', 'kept-by-pinned'],
    imageStateIds: ['only-in-evicted', 'kept-by-pinned'],
    now: NOW
  });
  assert.deepEqual(plan.evictDrafts, ['evicted']);
  assert.deepEqual(plan.evictOriginals, ['only-in-evicted']);
  assert.deepEqual(plan.evictImageStates, ['only-in-evicted']);
});

test('planEviction: cascade — every meta cached + stale → drafts evicted AND their orphaned originals reclaimed', () => {
  // Earlier gate was `surviving.length > 0`, which over-protected
  // this case (drafts gone, originals leaked forever). Now the gate
  // is `metas.length > 0` so the orphan sweep still runs.
  const plan = planEviction({
    metas: [
      {
        draftId: 'a',
        mode: 'cached',
        lastAccessedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
        refIds: ['only-in-a'],
        lockTs: null
      },
      {
        draftId: 'b',
        mode: 'cached',
        lastAccessedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
        refIds: ['only-in-b'],
        lockTs: null
      }
    ],
    originalsIds: ['only-in-a', 'only-in-b'],
    imageStateIds: ['only-in-a', 'only-in-b'],
    now: NOW
  });
  assert.deepEqual(plan.evictDrafts.sort(), ['a', 'b']);
  assert.deepEqual(plan.evictOriginals.sort(), ['only-in-a', 'only-in-b']);
  assert.deepEqual(plan.evictImageStates.sort(), ['only-in-a', 'only-in-b']);
});

test('planEviction: empty metas → true bootstrap, originals untouched', () => {
  // First mount with no drafts at all: the user might be about to
  // pin. Keep originals until at least one meta exists.
  const plan = planEviction({
    metas: [],
    originalsIds: ['from-prior-session'],
    imageStateIds: ['from-prior-session'],
    now: NOW
  });
  assert.deepEqual(plan.evictDrafts, []);
  assert.deepEqual(plan.evictOriginals, []);
  assert.deepEqual(plan.evictImageStates, []);
});

test('planEviction: image-state cleanup scoped to surviving refs', () => {
  const plan = planEviction({
    metas: [
      {
        draftId: 'survives',
        mode: 'pinned',
        lastAccessedAt: new Date(NOW).toISOString(),
        refIds: ['keep'],
        lockTs: null
      }
    ],
    originalsIds: ['keep'],
    imageStateIds: ['keep', 'orphan'],
    now: NOW
  });
  assert.deepEqual(plan.evictImageStates, ['orphan']);
});
