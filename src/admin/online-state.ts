// Online / verifying / offline state machine. Three signals:
//   1. window 'online' / 'offline' events (immediate)
//   2. navigator.onLine snapshot (consulted on mount)
//   3. periodic HEAD probe to /health (truth source — handles
//      "wifi without internet" cases where navigator.onLine lies)
//
// State is broadcast on the rkr-online BroadcastChannel so all
// tabs reflect the same connectivity. Sync (sync.ts) listens and
// triggers tryDrain() on online transitions.

const CHANNEL_NAME = 'rkr-online';
const PROBE_URL = '/health';
const PROBE_INTERVAL_MS = 5_000;

/** @public */
export type OnlineState = 'online' | 'verifying' | 'offline';

interface OnlineEvent {
  type: 'state';
  state: OnlineState;
}

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;

let current: OnlineState = 'verifying';
let probeTimer: ReturnType<typeof setTimeout> | null = null;

function publish(state: OnlineState): void {
  if (current === state) return;
  current = state;
  /* v8 ignore next 3 -- environments without BroadcastChannel skip */
  if (channel) {
    channel.postMessage({ type: 'state', state } satisfies OnlineEvent);
  }
}

/** @public */
export function getState(): OnlineState {
  return current;
}

/** @public */
export function onChange(handler: (state: OnlineState) => void): () => void {
  /* v8 ignore next 3 -- BroadcastChannel-less envs return no-op unsub */
  if (!channel) return () => {};
  const listener = (ev: MessageEvent<OnlineEvent>): void => {
    if (ev.data?.type === 'state') handler(ev.data.state);
  };
  channel.addEventListener('message', listener);
  return () => channel.removeEventListener('message', listener);
}

/** Single HEAD probe to /health. Returns true on 2xx, false on
 * any other response or network error. */
async function probe(): Promise<boolean> {
  try {
    const res = await fetch(PROBE_URL, { method: 'HEAD', cache: 'no-store' });
    return res.ok;
    /* v8 ignore next 3 -- network-error path; covered indirectly via offline scenarios */
  } catch {
    return false;
  }
}

/** Schedule the next probe. Single shared timer so multiple
 * onChange subscriptions don't multiply requests. */
function scheduleNextProbe(): void {
  /* v8 ignore next -- timer-clear race; harmless to skip */
  if (probeTimer !== null) clearTimeout(probeTimer);
  probeTimer = setTimeout(() => {
    void runProbe();
  }, PROBE_INTERVAL_MS);
}

async function runProbe(): Promise<void> {
  const wasOnline = current === 'online';
  publish('verifying');
  const ok = await probe();
  publish(ok ? 'online' : 'offline');
  // Re-probe on a 5s cadence ONLY when we're not currently online.
  // Once verified online, the next online check runs lazily — driven
  // by an actual sync attempt failing or by the window 'offline'
  // event firing.
  if (!ok) {
    scheduleNextProbe();
  } else if (!wasOnline) {
    // Edge: just transitioned offline → online. Cancel any pending
    // probe; a sync.tryDrain() would happen on this transition
    // (wired in phase 1f).
    /* v8 ignore next -- cleanup; harmless to leave a stale timer running */
    if (probeTimer !== null) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
  }
}

/** Wire window events and run an initial probe. Idempotent —
 * calling start() twice is safe but the second call won't add
 * duplicate listeners. Mount-time hook for the admin SPA. */
let started = false;
export function start(): void {
  if (started) return;
  started = true;

  // Immediate transitions on window events; they're fast signals
  // even when navigator.onLine isn't 100% reliable.
  /* v8 ignore start -- window event handlers; e2e covers them indirectly */
  window.addEventListener('online', () => {
    void runProbe();
  });
  window.addEventListener('offline', () => {
    publish('offline');
    scheduleNextProbe();
  });
  /* v8 ignore stop */

  // Initial state: trust navigator.onLine for the snapshot, then
  // probe to confirm. Wifi-without-internet returns true for
  // navigator.onLine but the probe will catch it.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    publish('offline');
    scheduleNextProbe();
  } else {
    void runProbe();
  }
}
