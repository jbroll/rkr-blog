// Connectivity state machine: online / offline. Combines window
// 'online'/'offline' events, navigator.onLine, and a HEAD probe to
// /health (the truth source — navigator.onLine returns true on
// "wifi without internet"). The probe runs internally; the
// in-between "checking" moment is NOT published, because every
// caller short-circuits it to "treat as online" anyway. Drain
// progress lives on a separate channel (sync.ts DrainStatus) and
// is the actionable signal users care about.

const CHANNEL_NAME = 'rkr-online';
const PROBE_URL = '/health';
const PROBE_INTERVAL_MS = 5_000;

/** @public */
export type OnlineState = 'online' | 'offline';

interface OnlineEvent {
  type: 'state';
  state: OnlineState;
}

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;

// Start optimistically. The first probe (kicked by `start()`) flips
// to 'offline' if /health is unreachable; until then no caller has
// any reason to queue.
let current: OnlineState = 'online';
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

// Monotonic counter — a stale in-flight probe (from the offline-
// state 5s scheduler) can finish AFTER a fresher 'online'-event-
// triggered probe and clobber the state with its own delayed
// result. Stamp each probe and only publish if it's still the
// latest.
let probeSeq = 0;

async function runProbe(): Promise<void> {
  const seq = ++probeSeq;
  const ok = await probe();
  if (seq !== probeSeq) return; // newer probe already settled the state
  publish(ok ? 'online' : 'offline');
  // Re-probe on a cadence only when offline. Once online, the next
  // check runs lazily via a sync attempt failing or a window 'offline'
  // event. Cancel any pending re-probe timer on success regardless of
  // wasOnline: a window 'offline' event (or a prior !ok probe) may have
  // scheduled a timer while this probe was in-flight, and leaving it
  // pending would fire a spurious extra runProbe after recovery.
  if (!ok) {
    scheduleNextProbe();
  } else {
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
