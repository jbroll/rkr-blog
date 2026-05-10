// Connectivity state machine: online / verifying / offline.
// Combines window 'online'/'offline' events, navigator.onLine, and
// a HEAD probe to /health (the truth source — navigator.onLine
// returns true on "wifi without internet").

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
// BroadcastChannel doesn't deliver to its own posters; same-tab
// subscribers need a separate fan-out.
const localHandlers = new Set<(state: OnlineState) => void>();

function publish(state: OnlineState): void {
  if (current === state) return;
  current = state;
  for (const h of localHandlers) h(state);
  /* v8 ignore next 3 -- BroadcastChannel-less env */
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
  localHandlers.add(handler);
  const cleanupLocal = () => localHandlers.delete(handler);
  /* v8 ignore next 3 -- BroadcastChannel-less env */
  if (!channel) return cleanupLocal;
  const listener = (ev: MessageEvent<OnlineEvent>): void => {
    if (ev.data?.type === 'state') handler(ev.data.state);
  };
  channel.addEventListener('message', listener);
  return () => {
    cleanupLocal();
    channel.removeEventListener('message', listener);
  };
}

async function probe(): Promise<boolean> {
  try {
    const res = await fetch(PROBE_URL, { method: 'HEAD', cache: 'no-store' });
    return res.ok;
    /* v8 ignore next 3 -- network-error path */
  } catch {
    return false;
  }
}

function scheduleNextProbe(): void {
  /* v8 ignore next -- timer-clear race */
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
  // Re-probe on a cadence only when not currently online. Once
  // online, the next check runs lazily via a sync attempt failing
  // or a window 'offline' event.
  if (!ok) {
    scheduleNextProbe();
  } else if (!wasOnline) {
    /* v8 ignore next -- timer cleanup */
    if (probeTimer !== null) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
  }
}

let started = false;
export function start(): void {
  if (started) return;
  started = true;

  /* v8 ignore start -- window-event handlers */
  window.addEventListener('online', () => {
    void runProbe();
  });
  window.addEventListener('offline', () => {
    publish('offline');
    scheduleNextProbe();
  });
  /* v8 ignore stop */

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    publish('offline');
    scheduleNextProbe();
  } else {
    void runProbe();
  }
}
