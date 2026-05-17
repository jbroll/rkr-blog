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
import { readFile } from 'node:fs/promises';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { OutboxEntry } from '../../src/lib/outbox-types.ts';
import { installMockOpfs } from './opfs-mock.ts';

const { resetMockOpfs, setGate } = installMockOpfs();

const { readBlob, writeJson } = await import('../../src/admin/opfs.ts');
const { ROOT_LOCK, mutateRoot, readRoot, writeRoot } = await import(
  '../../src/admin/opfs-schema.ts'
);
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

// ---- (c) Task 3: every _root.json mutation under ROOT_LOCK ---------

test('ROOT_LOCK is exactly the append lock name (append + mutateRoot share ONE lock)', () => {
  // The whole fix hinges on this: if these diverged, append() and the
  // currentDraftId / ensureSchema writers would take DIFFERENT locks
  // and the stale-nextSeq race would remain wide open.
  assert.equal(ROOT_LOCK, 'rkr-outbox-append');
});

test('mutateRoot serialises concurrent read-modify-writes (no lost update)', async () => {
  // Two concurrent mutateRoot calls both bump nextSeq. If they did NOT
  // serialise under ROOT_LOCK they'd both read 0 and both write 1
  // (final = 1, lost update). Serialised → the second observes the
  // first's persisted result → final = 2. (Sanity-checked: making
  // mutateRoot skip the lock makes this assertion fail.)
  await writeRoot({ schemaVersion: 1, deviceId: 'dev', nextSeq: 0 });
  const bump = (): Promise<unknown> =>
    mutateRoot((root) => ({ ...root, nextSeq: (root.nextSeq ?? 0) + 1 }));
  await Promise.all([bump(), bump()]);
  const root = await readRoot();
  assert.equal(root?.nextSeq, 2, 'both increments landed — neither clobbered the other');
});

test('a currentDraftId write cannot clobber an in-flight append’s nextSeq bump', async () => {
  // Model an append() parked at its JSON commit: by the time the gate
  // fires it has already done writeRoot({...root, nextSeq:6}) (5→6)
  // and written the blob, and still HOLDS the append lock. A racing
  // mutateRoot-based currentDraftId write must queue behind that lock
  // and observe the bumped nextSeq:6 — it must NOT persist a stale
  // nextSeq:5 read from before the bump.
  await writeRoot({ schemaVersion: 1, deviceId: 'dev', nextSeq: 5 });

  let release!: () => void;
  let gated = false;
  const gateHit = new Promise<void>((resolveHit) => {
    setGate((path) => {
      if (!gated && /\.6\.commitImageEdit\.json\.tmp-/.test(path)) {
        gated = true;
        resolveHit();
        return new Promise<void>((r) => {
          release = r;
        });
      }
      return null;
    });
  });

  const appendPromise = append(
    { op: 'commitImageEdit', payload: { id: 'img-1', hasBake: true } } as Omit<
      OutboxEntry,
      'seq' | 'createdAt' | 'deviceId'
    >,
    new Blob([new Uint8Array([1])])
  );

  // Append is now parked at the JSON commit: nextSeq already bumped to
  // 6 on disk, append lock still held.
  await gateHit;
  assert.equal((await readRoot())?.nextSeq, 6, 'precondition: append bumped nextSeq 5→6');

  // Kick a currentDraftId write concurrently. It enters mutateRoot,
  // which must block on the held append lock.
  const draftWrite = mutateRoot((root) => ({ ...root, currentDraftId: 'draft-X' }));

  // Let microtasks settle — a NON-locked write would have read the
  // (now-bumped) root, but a pre-fix unlocked path that had snapshotted
  // _root before the bump would clobber nextSeq back to 5 here.
  await Promise.resolve();
  await Promise.resolve();

  release();
  await appendPromise;
  await draftWrite;

  const root = await readRoot();
  assert.ok(
    (root?.nextSeq ?? 0) >= 6,
    `final nextSeq must be >= 6 (append's bump survived); got ${root?.nextSeq}`
  );
  assert.equal(root?.currentDraftId, 'draft-X', 'the currentDraftId write also landed');
});

test('no bare _root.json write escapes ROOT_LOCK in the currentDraftId writers + ensureSchema', async () => {
  // Structural backstop for the behavioral races above: assert no
  // module bypasses the lock by calling writeRoot(...) or
  // writeJson(ROOT_PATH, ...) directly. draft/pin/startup must not
  // import writeRoot/writeJson-to-root at all (every _root mutation
  // goes through mutateRoot); opfs-schema's only raw writes are inside
  // mutateRoot / a withRootLock callback.
  const here = fileURLToPath(import.meta.url);
  const adminDir = here.replace(/test\/admin\/startup-races\.test\.ts$/, 'src/admin/');

  for (const f of ['draft.ts', 'pin.ts', 'startup.ts']) {
    const src = await readFile(`${adminDir}${f}`, 'utf8');
    assert.equal(
      /\bwriteRoot\s*\(/.test(src),
      false,
      `${f}: must not call writeRoot() directly — route _root writes through mutateRoot`
    );
    assert.equal(
      /writeJson\s*\(\s*ROOT_PATH/.test(src),
      false,
      `${f}: must not writeJson(ROOT_PATH, ...) directly`
    );
  }

  // opfs-schema.ts: writeRoot's sole non-test caller must be mutateRoot
  // itself, and the only writeJson(ROOT_PATH, ...) left is the
  // migration write — which must sit inside a withRootLock callback.
  const schema = await readFile(`${adminDir}opfs-schema.ts`, 'utf8');
  const ensureBody = schema.slice(schema.indexOf('export async function ensureSchema'));
  assert.equal(
    /\bwriteRoot\s*\(/.test(ensureBody),
    false,
    'ensureSchema must not call writeRoot() directly'
  );
  // The only writeJson(ROOT_PATH ...) in ensureSchema is the migration
  // write; it must be lexically wrapped by withRootLock.
  const migrationIdx = ensureBody.indexOf('writeJson(ROOT_PATH');
  assert.ok(migrationIdx > 0, 'migration still writes _root via writeJson(ROOT_PATH ...)');
  const beforeMigration = ensureBody.slice(0, migrationIdx);
  const lastLock = beforeMigration.lastIndexOf('withRootLock');
  const lastReturn = beforeMigration.lastIndexOf('return {');
  assert.ok(
    lastLock > lastReturn,
    'the migration writeJson(ROOT_PATH ...) must be inside a withRootLock(...) callback'
  );
});
