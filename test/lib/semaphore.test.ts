import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Semaphore } from '../../src/lib/semaphore.ts';

test('Semaphore: acquire returns immediately while slots free', async () => {
  const s = new Semaphore(2);
  await s.acquire();
  await s.acquire();
  assert.deepEqual(s.state(), { available: 0, queued: 0 });
});

test('Semaphore: acquire past capacity blocks until release', async () => {
  const s = new Semaphore(1);
  await s.acquire();

  let resolved = false;
  const second = s.acquire().then(() => {
    resolved = true;
  });

  // Yield several microtasks; should still be queued.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.deepEqual(s.state(), { available: 0, queued: 1 });

  s.release();
  await second;
  assert.equal(resolved, true);
  assert.deepEqual(s.state(), { available: 0, queued: 0 });
});

test('Semaphore: release with no waiters returns capacity', async () => {
  const s = new Semaphore(2);
  await s.acquire();
  s.release();
  assert.deepEqual(s.state(), { available: 2, queued: 0 });
});

test('Semaphore: waiters wake in FIFO order', async () => {
  const s = new Semaphore(1);
  await s.acquire(); // holder 0
  const order: number[] = [];

  // Each waiter records its number then releases, handing the slot
  // to the next FIFO waiter.
  const tasks = [1, 2, 3].map((n) =>
    s.acquire().then(() => {
      order.push(n);
      s.release();
    })
  );

  await Promise.resolve();
  assert.deepEqual(s.state(), { available: 0, queued: 3 });

  // Original holder releases — wake cascades through 1, 2, 3.
  s.release();
  await Promise.all(tasks);
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(s.state(), { available: 1, queued: 0 });
});

test('Semaphore: caps concurrency under bursty load', async () => {
  const s = new Semaphore(2);
  let inflight = 0;
  let peak = 0;

  async function work(): Promise<void> {
    await s.acquire();
    inflight += 1;
    peak = Math.max(peak, inflight);
    // Yield to let other tasks try to enter.
    await new Promise<void>((r) => setImmediate(r));
    inflight -= 1;
    s.release();
  }

  await Promise.all(Array.from({ length: 8 }, () => work()));
  assert.equal(peak, 2);
  assert.deepEqual(s.state(), { available: 2, queued: 0 });
});

test('Semaphore: rejects bad capacity', () => {
  assert.throws(() => new Semaphore(0), /positive integer/);
  assert.throws(() => new Semaphore(-1), /positive integer/);
  assert.throws(() => new Semaphore(1.5), /positive integer/);
});
