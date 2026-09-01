// The outbox drain race: an entry appended between drainLoop's last
// emptiness check and the leader releasing the Web Lock got a no-op
// tryDrain (lock unavailable) and was stranded — nothing re-triggers
// a drain, there is no periodic sweep.
//
// The window is driven deterministically through the mock's write
// gate: runEviction runs at the tail of drainLoop, after `idle` is
// published and while the leader lock is still held, so parking the
// leader on eviction's first removeFile puts it exactly inside the
// window. No sleeps.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { installMockOpfs } from './opfs-mock.ts';

// sync.ts and online-state.ts each open a BroadcastChannel at import
// time, which is ref'd in Node and would keep the test process alive.
class NoopBroadcastChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
Object.defineProperty(globalThis, 'BroadcastChannel', {
  configurable: true,
  value: NoopBroadcastChannel
});

const { resetMockOpfs, setGate } = installMockOpfs();

const { writeJson } = await import('../../src/admin/opfs.ts');
const { writeRoot } = await import('../../src/admin/opfs-schema.ts');
const { append, list } = await import('../../src/admin/outbox.ts');
const { drainSavePost } = await import('../../src/admin/drainers.ts');
const { getStatus, registerDrainer, tryDrain } = await import('../../src/admin/sync.ts');

registerDrainer('savePost', drainSavePost);

beforeEach(async () => {
  resetMockOpfs();
  await writeRoot({ schemaVersion: 1, deviceId: 'dev', nextSeq: 0 });
});

function savePost(slug: string): Parameters<typeof append>[0] {
  return { op: 'savePost', payload: { slug, title: slug, markdown: '' } };
}

/** Give runEviction something to delete so the leader can be parked
 * on it: a `cached` draft whose lastAccessedAt is far past the TTL. */
async function seedEvictableDraft(draftId: string): Promise<void> {
  await writeJson(`drafts/${draftId}.json`, { draftId });
  await writeJson(`meta/${draftId}.json`, {
    schemaVersion: 1,
    draftId,
    mode: 'cached',
    lastAccessedAt: '2020-01-01T00:00:00.000Z'
  });
}

test('tryDrain: an entry appended while the leader is finishing is not stranded', async () => {
  await seedEvictableDraft('stale-1');

  let release!: () => void;
  let gated = false;
  const parked = new Promise<void>((resolveHit) => {
    setGate((path) => {
      if (!gated && path === '/drafts/stale-1.json') {
        gated = true;
        resolveHit();
        return new Promise<void>((r) => {
          release = r;
        });
      }
      return null;
    });
  });

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

  await append(savePost('a'));
  const leader = tryDrain();

  // The leader has drained 'a', published idle, and is now inside
  // runEviction with the leader lock still held.
  await parked;
  assert.deepEqual(await list(), [], 'precondition: the queue looked empty to the leader');

  await append(savePost('b'));
  await tryDrain();
  assert.equal((await list()).length, 1, 'precondition: the second tryDrain was a no-op');

  release();
  await leader;

  assert.deepEqual(await list(), [], 'outbox should be empty after the leader settles');
});

test('tryDrain: a conflicted head does not spin the re-check loop', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: 'post-superseded' }), { status: 409 });
  }) as typeof fetch;

  await append(savePost('c'));
  await tryDrain();

  assert.equal(getStatus().kind, 'conflict');
  assert.ok(calls <= 2, `expected the loop to stop on conflict, saw ${calls} attempts`);
  assert.equal((await list()).length, 1, 'the conflicted entry stays queued for the author');
});
