import assert from 'node:assert/strict';
import { test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import {
  claim,
  complete,
  enqueue,
  events,
  type JobHandler,
  type JobHandlerCtx,
  type JobHandlerMap,
  workQueue
} from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';

interface JobsTableRow {
  id: number;
  kind: string;
  state: string;
  cache_key: string | null;
  payload: string;
  error: string | null;
}

function freshDb() {
  const db = open(':memory:');
  migrate(db);
  return db;
}

const noopCtx: JobHandlerCtx = { siteRoot: '/tmp/rkr-jobs-test' };

test('enqueue inserts a queued row and returns its id', () => {
  const db = freshDb();
  try {
    const r = enqueue(db, { kind: 'render', payload: { hello: 1 }, cacheKey: 'abc' });
    assert.equal(r.duplicate, false);
    assert.ok(r.id > 0);

    const row = db
      .prepare<JobsTableRow>('SELECT kind, state, cache_key FROM jobs WHERE id=?')
      .get(r.id);
    assert.ok(row);
    assert.equal(row.kind, 'render');
    assert.equal(row.state, 'queued');
    assert.equal(row.cache_key, 'abc');
  } finally {
    db.close();
  }
});

test('enqueue dedupes by cache_key while a job is queued or running', () => {
  const db = freshDb();
  try {
    const a = enqueue(db, { kind: 'render', payload: { x: 1 }, cacheKey: 'same' });
    const b = enqueue(db, { kind: 'render', payload: { x: 2 }, cacheKey: 'same' });
    assert.equal(b.duplicate, true);
    assert.equal(b.id, a.id);

    const count = db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE cache_key='same'")
      .get();
    assert.equal(count?.n, 1, 'only one row should exist for the same cache_key');
  } finally {
    db.close();
  }
});

test('enqueue resets a done job back to queued (same row, not duplicate)', () => {
  const db = freshDb();
  try {
    const a = enqueue(db, { kind: 'render', payload: { v: 1 }, cacheKey: 'k1' });
    claim(db);
    complete(db, a.id);
    assert.equal(
      db.prepare<JobsTableRow>('SELECT state FROM jobs WHERE id=?').get(a.id)?.state,
      'done'
    );

    const b = enqueue(db, { kind: 'render', payload: { v: 2 }, cacheKey: 'k1' });
    assert.equal(b.duplicate, false, 're-enqueue after done is not a duplicate');
    assert.equal(b.id, a.id, 'cache_key UNIQUE → same row, reset to queued');

    const row = db
      .prepare<JobsTableRow>('SELECT state, payload, error FROM jobs WHERE id=?')
      .get(a.id);
    assert.ok(row);
    assert.equal(row.state, 'queued');
    assert.equal((JSON.parse(row.payload) as { v: number }).v, 2, 'payload is updated');
    assert.equal(row.error, null);

    const count = db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE cache_key='k1'")
      .get();
    assert.equal(count?.n, 1);
  } finally {
    db.close();
  }
});

test('claim returns jobs in FIFO order and marks them running', () => {
  const db = freshDb();
  try {
    const a = enqueue(db, { kind: 'render', payload: { tag: 'a' } });
    const b = enqueue(db, { kind: 'render', payload: { tag: 'b' } });

    const j1 = claim<{ tag: string }>(db);
    assert.ok(j1);
    assert.equal(j1.id, a.id);
    assert.equal(j1.payload.tag, 'a');

    const j2 = claim<{ tag: string }>(db);
    assert.ok(j2);
    assert.equal(j2.id, b.id);

    const j3 = claim(db);
    assert.equal(j3, null, 'no more queued jobs');

    const states = db
      .prepare<{ state: string }>('SELECT state FROM jobs WHERE id IN (?,?) ORDER BY id')
      .all(a.id, b.id)
      .map((r) => r.state);
    assert.deepEqual(states, ['running', 'running']);
  } finally {
    db.close();
  }
});

test('atomic claim: parallel claim attempts on the same job → exactly one wins', async () => {
  const db = freshDb();
  try {
    enqueue(db, { kind: 'render', payload: {} });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => Promise.resolve().then(() => claim(db)))
    );

    const winners = results.filter((r) => r !== null);
    assert.equal(winners.length, 1, `exactly one claim should succeed, got ${winners.length}`);
    const losers = results.filter((r) => r === null);
    assert.equal(losers.length, 19);
  } finally {
    db.close();
  }
});

test('complete marks done; complete with error marks failed and stores message', () => {
  const db = freshDb();
  try {
    const ok = enqueue(db, { kind: 'render', payload: {} });
    claim(db);
    complete(db, ok.id);
    assert.equal(
      db.prepare<JobsTableRow>('SELECT state FROM jobs WHERE id=?').get(ok.id)?.state,
      'done'
    );

    const bad = enqueue(db, { kind: 'render', payload: {} });
    claim(db);
    complete(db, bad.id, { error: 'kaboom' });
    const row = db.prepare<JobsTableRow>('SELECT state, error FROM jobs WHERE id=?').get(bad.id);
    assert.ok(row);
    assert.equal(row.state, 'failed');
    assert.equal(row.error, 'kaboom');
  } finally {
    db.close();
  }
});

test('workQueue runs handlers, marks done, and exits when drainAndExit + queue empty', async () => {
  const db = freshDb();
  try {
    const seen: string[] = [];
    const renderHandler: JobHandler<{ tag: string }> = async (payload) => {
      seen.push(payload.tag);
    };
    const handlers: JobHandlerMap = { render: renderHandler as JobHandler<unknown> };

    enqueue(db, { kind: 'render', payload: { tag: 'a' } });
    enqueue(db, { kind: 'render', payload: { tag: 'b' } });
    enqueue(db, { kind: 'render', payload: { tag: 'c' } });

    const ctrl = workQueue({ db, ctx: noopCtx, handlers, concurrency: 2, drainAndExit: true });
    await ctrl.done;

    assert.deepEqual([...seen].sort(), ['a', 'b', 'c']);
    const states = db
      .prepare<{ state: string }>('SELECT state FROM jobs ORDER BY id')
      .all()
      .map((r) => r.state);
    assert.deepEqual(states, ['done', 'done', 'done']);
  } finally {
    db.close();
  }
});

test('workQueue: handler throw → state=failed with error message', async () => {
  const db = freshDb();
  try {
    const handlers: JobHandlerMap = {
      render: async () => {
        throw new Error('handler boom');
      }
    };
    const j = enqueue(db, { kind: 'render', payload: {} });

    const ctrl = workQueue({ db, ctx: noopCtx, handlers, drainAndExit: true });
    await ctrl.done;

    const row = db.prepare<JobsTableRow>('SELECT state, error FROM jobs WHERE id=?').get(j.id);
    assert.ok(row);
    assert.equal(row.state, 'failed');
    assert.match(row.error ?? '', /handler boom/);
  } finally {
    db.close();
  }
});

test('events.emit("enqueued") wakes a waiting worker faster than the poll interval', async () => {
  const db = freshDb();
  try {
    const handlers: JobHandlerMap = { render: async () => {} };
    const ctrl = workQueue({ db, ctx: noopCtx, handlers, drainAndExit: false });

    await new Promise((r) => setTimeout(r, 50));

    const before = Date.now();
    enqueue(db, { kind: 'render', payload: {} });

    while (true) {
      const row = db.prepare<{ state: string }>('SELECT state FROM jobs LIMIT 1').get();
      if (row && row.state === 'done') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const elapsed = Date.now() - before;

    await ctrl.stop();
    assert.ok(elapsed < 200, `elapsed=${elapsed}ms — expected wake-on-emit < 200ms`);
  } finally {
    db.close();
  }
});

test.after(() => {
  events.removeAllListeners('enqueued');
});
