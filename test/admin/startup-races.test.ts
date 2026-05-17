// Startup serialization (Task 21): two boot-time races.
//
// (a) The orphan sweeps (gcUnderAppendLock → gcOrphansAgainstOutbox +
//     gcAtomicWriteTemps) must run under the rkr-outbox-append Web
//     Lock so they can't observe append()'s half-written window
//     (blob written, JSON not yet) and delete the live blob — which
//     would wedge the next commitImageEdit drain on `no blob`.
// (b) dropLegacyOpEntries() must complete before the first tryDrain
//     so the drain loop never observes a legacy op and never flashes
//     a spurious `halted` badge.
//
// Both interleavings are driven deterministically via the mock's
// write gate + the navigator.locks mock — no arbitrary sleeps.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import type { OutboxEntry } from '../../src/lib/outbox-types.ts';
import { installMockOpfs } from './opfs-mock.ts';

const { resetMockOpfs, setGate } = installMockOpfs();

const { readBlob, writeJson } = await import('../../src/admin/opfs.ts');
const { writeRoot } = await import('../../src/admin/opfs-schema.ts');
const { append, gcUnderAppendLock, dropLegacyOpEntries, readEntryBlob, list } = await import(
  '../../src/admin/outbox.ts'
);

beforeEach(async () => {
  resetMockOpfs();
  await writeRoot({ schemaVersion: 1, deviceId: 'dev', nextSeq: 0 });
});

// ---- (a) sweep vs in-flight append ---------------------------------

test('gcUnderAppendLock does not delete an in-flight append’s blob', async () => {
  // Gate append()'s JSON commit: the blob is written first, so when
  // the gate fires the entry is in the half-written (blob-but-no-
  // JSON) window — exactly the state a racing sweep used to corrupt.
  // opfs.ts atomicWrite stages into a sibling `.<leaf>.tmp-<uuid>`
  // then move()s it onto the target, so the gated write path is the
  // JSON commit's temp (`outbox/.1.commitImageEdit.json.tmp-<uuid>`),
  // not the final leaf. The blob's own temp (`.1.bin.tmp-`) and the
  // _root.json temp are distinct names, so only the JSON commit is
  // gated — the blob is already fully written + moved by then.
  let release!: () => void;
  let gated = false;
  const gateHit = new Promise<void>((resolveHit) => {
    setGate((path) => {
      if (!gated && /\.1\.commitImageEdit\.json\.tmp-/.test(path)) {
        gated = true;
        resolveHit();
        return new Promise<void>((r) => {
          release = r;
        });
      }
      return null;
    });
  });

  const blob = new Blob([new Uint8Array([7, 8, 9])]);
  const appendPromise = append(
    { op: 'commitImageEdit', payload: { id: 'img-1', hasBake: true } } as Omit<
      OutboxEntry,
      'seq' | 'createdAt' | 'deviceId'
    >,
    blob
  );

  // Wait until append is parked at the JSON commit (blob already on
  // disk, JSON not yet, append lock still held).
  await gateHit;
  assert.ok(
    await readBlob('outbox-blobs/1.bin'),
    'precondition: append wrote the blob before parking at JSON commit'
  );

  // Kick the sweep while the half-written state is observable. Under
  // the fix it queues behind the held append lock; pre-fix it ran
  // immediately and deleted outbox-blobs/1.bin.
  const sweepPromise = gcUnderAppendLock();

  // Let microtasks settle so a non-serialized sweep would have run.
  await Promise.resolve();
  await Promise.resolve();

  release();
  await appendPromise;
  await sweepPromise;

  // The just-appended blob must survive (sweep saw the committed JSON,
  // or never ran before the commit) and the entry must drain cleanly.
  assert.ok(await readEntryBlob(1), 'in-flight append blob survived the concurrent sweep');
  const entries = await list();
  assert.equal(entries.length, 1, 'the appended entry is intact in the outbox');
  assert.equal(entries[0]?.seq, 1);
});

// ---- (b) legacy drop awaited before first drain --------------------

// sync.ts uses a TS parameter property and so can't be imported under
// node --experimental-strip-types (strip-only). The drain loop's halt
// trigger is purely: it reads outboxList(), takes entries[0], finds no
// registered drainer for entries[0].op, and publishes `halted`. So the
// faithful, sync-free observation point for "the first drain" is
// `(await list())[0]?.op`. The race is whether the legacy entry is
// still in that list when the first drain reads it.
async function firstDrainWouldHaltOnLegacy(): Promise<boolean> {
  const LEGACY = new Set(['setOps', 'bake']);
  const head = (await list())[0];
  // No registered drainer for setOps/bake in this build → drainLoop
  // publishes { kind: 'halted', reason: `no drainer for op=...` }.
  return head != null && LEGACY.has(head.op as string);
}

interface LegacyEntry {
  seq: number;
  createdAt: string;
  deviceId: string;
  op: string;
  payload: Record<string, unknown>;
}

function seedLegacy(): Promise<void> {
  const legacy: LegacyEntry = {
    seq: 1,
    createdAt: new Date().toISOString(),
    deviceId: 'dev',
    op: 'setOps',
    payload: {}
  };
  return writeJson('outbox/1.setOps.json', legacy);
}

test('startup ordering (FIX): awaiting the legacy drop before the first drain leaves nothing for the drain to halt on', async () => {
  await seedLegacy();
  assert.ok(
    await firstDrainWouldHaltOnLegacy(),
    'precondition: a legacy op is present and would halt the drain'
  );

  // startup.ts new ordering: `await dropLegacyOpEntries()` THEN drain.
  await dropLegacyOpEntries();

  assert.equal(
    await firstDrainWouldHaltOnLegacy(),
    false,
    'the first drain observes no legacy op — no spurious halted flash'
  );
  assert.equal((await list()).length, 0, 'legacy entry was dropped');
});

test('startup ordering (PRE-FIX repro): void-ing the legacy drop lets the first drain observe the legacy op', async () => {
  await seedLegacy();

  // startup.ts old ordering: `void dropLegacyOpEntries()` (fire-and-
  // forget) then the drain runs. The drain's head read happens before
  // the un-awaited drop finished removing the entry — proving the race
  // the fix closes. (Asserts the pre-change bug is real; the FIX test
  // above asserts it's gone.)
  const dropping = dropLegacyOpEntries();
  const halts = await firstDrainWouldHaltOnLegacy();
  await dropping;

  assert.ok(halts, 'pre-fix: first drain observed the still-present legacy op (spurious halted)');
});
