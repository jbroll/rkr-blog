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

test('planEviction: cached eviction releases its refIds (orphans bubble up to originals)', () => {
  const plan = planEviction({
    metas: [
      {
        draftId: 'evicted',
        mode: 'cached',
        lastAccessedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
        refIds: ['only-in-evicted'],
        lockTs: null
      }
    ],
    originalsIds: ['only-in-evicted'],
    imageStateIds: ['only-in-evicted'],
    now: NOW
  });
  assert.deepEqual(plan.evictDrafts, ['evicted']);
  // Once the draft is gone, no surviving meta references the id, so
  // the original drops from disk too.
  assert.deepEqual(plan.evictOriginals, ['only-in-evicted']);
  assert.deepEqual(plan.evictImageStates, ['only-in-evicted']);
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
