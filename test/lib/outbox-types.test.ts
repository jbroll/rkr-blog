import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coalescePending, type OutboxEntry } from '../../src/lib/outbox-types.ts';

function entry(seq: number, op: OutboxEntry['op'], extra: Record<string, unknown>): OutboxEntry {
  // Cast through unknown — the discriminated union doesn't accept a
  // generic object literal; tests build minimal valid entries per op.
  return {
    seq,
    op,
    createdAt: '2026-05-09T00:00:00.000Z',
    deviceId: 'test-device',
    ...extra
  } as unknown as OutboxEntry;
}

test('coalescePending: empty array → empty', () => {
  assert.deepEqual(coalescePending([]), []);
});

test('coalescePending: single entry preserved', () => {
  const e = entry(1, 'upload', {
    payload: { id: 'abc', filename: 'a.png', mimeType: 'image/png' }
  });
  assert.deepEqual(coalescePending([e]), [e]);
});

test('coalescePending: two savePost entries for same slug → keep latest', () => {
  const earlier = entry(3, 'savePost', {
    payload: { slug: 'my-post', title: 'A', status: 'draft', markdown: 'v1' }
  });
  const later = entry(7, 'savePost', {
    payload: { slug: 'my-post', title: 'B', status: 'published', markdown: 'v2' }
  });
  const result = coalescePending([earlier, later]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.seq, 7);
});

test('coalescePending: savePost entries for different slugs both kept', () => {
  const a = entry(3, 'savePost', {
    payload: { slug: 'post-a', title: 'A', status: 'draft', markdown: '' }
  });
  const b = entry(5, 'savePost', {
    payload: { slug: 'post-b', title: 'B', status: 'draft', markdown: '' }
  });
  assert.deepEqual(
    coalescePending([a, b]).map((e) => e.seq),
    [3, 5]
  );
});

test('coalescePending: two new posts (slug:""), distinct draftId → both kept', () => {
  // Brand-new posts both queue savePost with slug:'' (server
  // slugifies later). Keying on slug alone collapses them and the
  // drain DELETES all but the highest seq → silent data loss.
  const a = entry(2, 'savePost', {
    draftId: 'A',
    payload: { slug: '', title: 'First', markdown: 'one' }
  });
  const b = entry(4, 'savePost', {
    draftId: 'B',
    payload: { slug: '', title: 'Second', markdown: 'two' }
  });
  assert.deepEqual(
    coalescePending([a, b]).map((e) => e.seq),
    [2, 4]
  );
});

test('coalescePending: two saves of one new post (same draftId) → keep latest', () => {
  const earlier = entry(1, 'savePost', {
    draftId: 'A',
    payload: { slug: '', title: 'Draft', markdown: 'v1' }
  });
  const later = entry(3, 'savePost', {
    draftId: 'A',
    payload: { slug: '', title: 'Draft', markdown: 'v2' }
  });
  const result = coalescePending([earlier, later]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.seq, 3);
});

test('coalescePending: new posts (slug:"") with NO draftId never coalesce', () => {
  // Safe degradation: a missing draftId falls back to a per-seq key
  // so two no-draftId new posts are never merged → no data loss,
  // only a redundant drain.
  const a = entry(2, 'savePost', {
    payload: { slug: '', title: 'First', markdown: 'one' }
  });
  const b = entry(4, 'savePost', {
    payload: { slug: '', title: 'Second', markdown: 'two' }
  });
  assert.deepEqual(
    coalescePending([a, b]).map((e) => e.seq),
    [2, 4]
  );
});

test('coalescePending: commitImageEdit coalesces by id, latest seq wins', () => {
  const earlier = entry(2, 'commitImageEdit', {
    payload: { id: 'abc', ops: [], redoStack: [], hasBake: false }
  });
  const later = entry(8, 'commitImageEdit', {
    payload: {
      id: 'abc',
      ops: [{ type: 'rotate', degrees: 90 }],
      redoStack: [],
      hasBake: true
    }
  });
  const other = entry(5, 'commitImageEdit', {
    payload: { id: 'def', ops: [], redoStack: [], hasBake: false }
  });
  const result = coalescePending([earlier, later, other]);
  // Both ids represented, but only the latest commit for `abc`.
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((e) => e.seq).sort((a, b) => a - b),
    [5, 8]
  );
});

test('coalescePending: upload entries coalesce by id, latest seq wins', () => {
  // Same image added twice offline → only the latest upload drains.
  // The blob is stored once in originals/<id>.<ext>; sending twice
  // wastes bandwidth (server dedup makes the second a no-op anyway).
  const a = entry(1, 'upload', {
    payload: { id: 'abc', filename: 'a.png', mimeType: 'image/png' }
  });
  const b = entry(2, 'upload', {
    payload: { id: 'abc', filename: 'a.png', mimeType: 'image/png' }
  });
  const result = coalescePending([a, b]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.seq, 2);
});

test('coalescePending: upload entries with different ids both kept', () => {
  const a = entry(1, 'upload', {
    payload: { id: 'abc', filename: 'a.png', mimeType: 'image/png' }
  });
  const b = entry(2, 'upload', {
    payload: { id: 'def', filename: 'b.png', mimeType: 'image/png' }
  });
  assert.deepEqual(
    coalescePending([a, b]).map((e) => e.seq),
    [1, 2]
  );
});

test('coalescePending: mixed ops preserve causal order across kept entries', () => {
  // upload → savePost(draft) → savePost(final). Coalescing drops the
  // earlier savePost; upload stays first.
  const upload = entry(1, 'upload', {
    payload: { id: 'abc', filename: 'a.png', mimeType: 'image/png' }
  });
  const draft = entry(2, 'savePost', {
    payload: { slug: 's', title: 'd', status: 'draft', markdown: '' }
  });
  const final = entry(3, 'savePost', {
    payload: { slug: 's', title: 'f', status: 'published', markdown: '' }
  });
  const result = coalescePending([upload, draft, final]);
  assert.deepEqual(
    result.map((e) => e.seq),
    [1, 3]
  );
});
