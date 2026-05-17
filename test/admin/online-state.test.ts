// Unit tests for the online-state state machine.
//
// The module has top-level mutable state (current, probeTimer, probeSeq,
// started, localHandlers) and relies on browser globals: fetch, setTimeout,
// clearTimeout, BroadcastChannel, window, navigator.
//
// Strategy: install all globals BEFORE the dynamic import so the module
// initialises against our stubs. Each test builds on the same module
// instance (can't reset module-level state); tests are sequenced so the
// final state of one is the expected starting state of the next.
// The single focused "leak" test covers the exact race described in the
// task: initial runProbe (wasOnline=true) races with window 'offline',
// which schedules a probeTimer that must be cleared when the in-flight
// probe resolves OK.
//
// Hang prevention: every real setTimeout handle issued to the module is
// recorded; after each test we call clearTimeout on any that weren't
// already cancelled, and we reject every unreachable pending probe so the
// process can exit cleanly.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

// ── Stubs installed before the module loads ──────────────────────────

// Track clearTimeout calls so we can assert the timer was cancelled.
const clearedHandles = new Set<ReturnType<typeof setTimeout>>();
// All handles issued to the module (so we can drain them after each test).
const allIssuedHandles: Array<ReturnType<typeof setTimeout>> = [];

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

// Override setTimeout: record every handle before returning it.
globalThis.setTimeout = ((
  fn: TimerHandler,
  delay?: number,
  ...args: unknown[]
): ReturnType<typeof setTimeout> => {
  const handle = originalSetTimeout(fn, delay, ...args) as unknown as ReturnType<typeof setTimeout>;
  allIssuedHandles.push(handle);
  return handle;
}) as unknown as typeof globalThis.setTimeout;

// Override clearTimeout: record cancellations.
globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]): void => {
  if (handle != null) clearedHandles.add(handle as ReturnType<typeof setTimeout>);
  originalClearTimeout(handle);
}) as unknown as typeof globalThis.clearTimeout;

// Controlled fetch: each call parks in pendingProbes until resolved/rejected.
const pendingProbes: Array<{
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
}> = [];

globalThis.fetch = async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
  new Promise((resolve, reject) => {
    pendingProbes.push({ resolve, reject });
  });

// BroadcastChannel: Node v22 ships BroadcastChannel, but a real one keeps
// the event loop alive via an internal port. Replace it with a no-op stub
// that the module can create without preventing process exit.
class MockBroadcastChannel {
  addEventListener() {}
  removeEventListener() {}
  postMessage() {}
  close() {}
}
// @ts-expect-error — intentional partial stub
globalThis.BroadcastChannel = MockBroadcastChannel;

// Window event listeners: capture 'online'/'offline' dispatchers.
const windowListeners = new Map<string, Array<EventListenerOrEventListenerObject>>();
globalThis.window = {
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    let arr = windowListeners.get(type);
    if (!arr) {
      arr = [];
      windowListeners.set(type, arr);
    }
    arr.push(listener);
  },
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const arr = windowListeners.get(type);
    if (arr) {
      const idx = arr.indexOf(listener);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }
} as unknown as Window & typeof globalThis;

function dispatchWindowEvent(type: string): void {
  const arr = windowListeners.get(type) ?? [];
  for (const l of arr) {
    if (typeof l === 'function') {
      l(new Event(type));
    } else {
      l.handleEvent(new Event(type));
    }
  }
}

// navigator.onLine: start true (online).
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { onLine: true }
});

// ── Import after stubs are in place ──────────────────────────────────

// The dynamic import ensures globals above are installed before the
// module's top-level BroadcastChannel check runs.
const { start, getState, onChange } = await import('../../src/admin/online-state.ts');

// ── Shared helpers ────────────────────────────────────────────────────

// Resolve a pending probe with ok=true (200 OK).
function resolvePendingProbe(index = 0): void {
  const entry = pendingProbes.splice(index, 1)[0];
  if (!entry) throw new Error('no pending probe to resolve');
  entry.resolve(new Response(null, { status: 200 }));
}

// Drain the microtask queue.
function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

// Cancel all timers issued during the test and drain parked probes.
// Resolving probes as OK (not rejecting) ensures runProbe() takes the
// `else { clearTimeout }` path and does NOT schedule another re-probe,
// avoiding an infinite cascade. We loop until the activity quiesces.
async function drainPendingActivity(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    // Cancel any still-pending timers.
    for (const h of allIssuedHandles) {
      if (!clearedHandles.has(h)) {
        originalClearTimeout(h as Parameters<typeof originalClearTimeout>[0]);
        clearedHandles.add(h);
      }
    }
    allIssuedHandles.length = 0;
    // Resolve parked probes as OK so runProbe() clears its timer and
    // returns without scheduling a new one.
    const snap = pendingProbes.splice(0);
    for (const p of snap) p.resolve(new Response(null, { status: 200 }));
    if (snap.length === 0) break;
    // Let the resolved probes run to completion before checking again.
    await new Promise<void>((r) => setImmediate(r));
  }
}

afterEach(async () => {
  await drainPendingActivity();
});

// ── Tests ─────────────────────────────────────────────────────────────

test('getState() starts online before start() is called', () => {
  assert.equal(getState(), 'online');
});

// The leak: initial runProbe captures wasOnline=true (module starts as
// 'online'). While the fetch is in-flight, window 'offline' fires →
// scheduleNextProbe() sets probeTimer=T1 and flips state to 'offline'.
// When the in-flight probe then resolves OK:
//   BUG  — old code: `else if (!wasOnline)` is false → T1 not cleared → T1
//           fires a spurious extra runProbe after recovery.
//   FIX  — new code: `else` unconditionally → T1 cleared on any ok result.
test('ok probe while wasOnline=true clears any pending re-probe timer', async () => {
  assert.equal(pendingProbes.length, 0, 'precondition: no pending probes');

  // Snapshot of issued handles before start() so we can identify T1.
  const handlesBefore = allIssuedHandles.length;

  start(); // first call; kicks off initial runProbe (probe #1 → pendingProbes)

  await flushMicrotasks();
  assert.ok(pendingProbes.length > 0, 'probe #1 should be in-flight after start()');

  // Fire 'offline' while probe #1 is still awaiting the network.
  // publish('offline') flips state; scheduleNextProbe() sets probeTimer=T1.
  dispatchWindowEvent('offline');
  await flushMicrotasks();

  assert.equal(getState(), 'offline', 'state is offline after the window offline event');
  assert.ok(
    allIssuedHandles.length > handlesBefore,
    'a re-probe timer (T1) should have been scheduled by scheduleNextProbe'
  );

  const t1Handle = allIssuedHandles.at(-1)!;

  // Resolve probe #1 with ok=true.
  // wasOnline was snapshotted as true (current was 'online' when runProbe
  // started). With the fix the `else` branch always clears probeTimer.
  resolvePendingProbe(0);
  await flushMicrotasks();

  assert.equal(getState(), 'online', 'state returns to online after ok probe');

  // The key assertion: T1 must be cleared so it never fires.
  assert.ok(
    clearedHandles.has(t1Handle),
    'probeTimer set during in-flight probe must be cancelled by the ok result — ' +
      'a surviving T1 would fire a spurious extra runProbe after recovery'
  );
});

test('onChange handler receives offline then online transitions', async () => {
  // State is 'online' coming out of the previous test.
  const states: string[] = [];
  const unsub = onChange((s) => states.push(s));

  // offline → state change notified immediately
  dispatchWindowEvent('offline');
  await flushMicrotasks();
  assert.deepEqual(states, ['offline']);

  // online event → runProbe fires; resolve it OK → back to online
  dispatchWindowEvent('online');
  await flushMicrotasks();
  if (pendingProbes.length > 0) {
    resolvePendingProbe(0);
    await flushMicrotasks();
  }

  assert.ok(states.includes('offline'), 'handler received offline transition');
  assert.ok(states.includes('online'), 'handler received online transition');

  unsub();
});
