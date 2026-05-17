// Shared per-IP failed-credential tally. Used by BOTH the browser
// token-login route (src/routes/auth.ts) and the bearer-header
// middleware (src/lib/auth-middleware.ts) so a single attacker IP
// can't sidestep the brute-force ceiling by switching between the
// two ADMIN_TOKEN entry points.
//
// Only WRONG credentials should call recordFailure — correct
// submissions, empty bodies and "server not configured" responses
// don't shrink the search space and must not burn the budget. A
// clean success calls clearFailures so an operator who logs in/out
// a few times isn't treated as an attacker.
//
// The window/ceiling here REUSE the constants previously inlined in
// auth.ts (ceiling 5, window 5 minutes) so the browser route's
// observable behavior is identical after the refactor. The map is
// process-wide (the brute-force concern is per-IP across the whole
// process, not per-fastify-instance); tests reset it via
// _resetLoginThrottle in their setup helpers.
//
// OPERATIONAL REQUIREMENT — the fronting proxy MUST strip inbound
// X-Forwarded-For before forwarding to this process (e.g. Apache:
//   RequestHeader unset X-Forwarded-For
// placed immediately before ProxyPass). Without it a client can
// spoof req.ip by supplying their own X-Forwarded-For header, making
// the per-IP throttle void. Fastify's trustProxy:'loopback' ensures
// the loopback hop is trusted but cannot defend against a spoofed
// header arriving from the proxy if the proxy does not strip it first.

/** Hard upper bound on the number of IPs tracked simultaneously. An
 * in-window rotating-IP spray must not grow the tally unbounded;
 * sweepExpired only drops *expired* entries (none expire during an
 * active spray). When the map is full we prefer evicting an
 * un-throttled entry so a persistent attacker already over the ceiling
 * is never reset by a spray flood. See EVICT_SCAN. */
const MAX_TRACKED_IPS = 10_000;

/** How many of the oldest Map entries to scan when looking for an
 * un-throttled (count < DEFAULT_MAX) eviction candidate. Keeps the
 * cap-eviction path O(1) even for a saturated table. */
const EVICT_SCAN = 32;

/** Default per-IP failed-attempt ceiling. `isThrottled` is true once
 * the recorded count reaches this within the window. Matches the old
 * `tokenLoginMax` default in auth.ts. */
export const DEFAULT_MAX = 5;

/** Sliding window in ms. Matches the old `tokenLoginWindowMs`. */
export const WINDOW_MS = 5 * 60 * 1000;

interface FailureWindow {
  count: number;
  resetAt: number;
}

const failures = new Map<string, FailureWindow>();

/** True when a window has passed its expiry time. Single source of
 * truth for the expiry condition used by both activeWindow and
 * sweepExpired. */
function isExpired(w: FailureWindow, now: number): boolean {
  return w.resetAt <= now;
}

/** Returns the live window for `ip`, dropping it first if it has
 * expired so a stale window never counts against a new attempt. */
function activeWindow(ip: string): FailureWindow | undefined {
  const w = failures.get(ip);
  if (!w) return undefined;
  if (isExpired(w, Date.now())) {
    failures.delete(ip);
    return undefined;
  }
  return w;
}

/** O(n) sweep: remove every entry whose window has expired. Called
 * opportunistically in recordFailure when opening a new window, so
 * IPs an attacker never revisits don't accumulate indefinitely.
 * Mirrors the sweepExpiredFlows pattern in src/routes/auth.ts. */
function sweepExpired(): void {
  const now = Date.now();
  for (const [k, v] of failures) {
    if (isExpired(v, now)) failures.delete(k);
  }
}

/** Record one failed credential attempt for `ip`. Starts a fresh
 * window if there is none (or the previous one expired). */
export function recordFailure(ip: string): void {
  const w = activeWindow(ip);
  if (w) {
    w.count += 1;
    return;
  }
  // New window: opportunistically purge expired entries for other IPs
  // so rotating-IP attackers can't grow the Map without bound.
  sweepExpired();
  if (failures.size >= MAX_TRACKED_IPS) {
    // In-window IP-spray flood. Prefer evicting an un-throttled
    // (count < DEFAULT_MAX) entry so a persistent attacker that has
    // already crossed the ceiling is never reset by the spray. Map
    // updates keep a key's original insertion slot, so a long-lived
    // attacker entry is "old" — without this preference an attacker
    // running a botnet-scale spray could position their brute-force
    // IP as oldest and keep resetting its count. Bounded scan keeps
    // this O(1); if the oldest EVICT_SCAN entries are all throttled
    // the table is already saturated with throttled IPs (the defense
    // working) and evicting the oldest is acceptable.
    let victim: string | undefined;
    let scanned = 0;
    for (const [k, w] of failures) {
      if (w.count < DEFAULT_MAX) {
        victim = k;
        break;
      }
      if (++scanned >= EVICT_SCAN) break;
    }
    if (victim === undefined) victim = failures.keys().next().value;
    /* v8 ignore next -- unreachable: size >= MAX_TRACKED_IPS > 0 */
    if (victim !== undefined) failures.delete(victim);
  }
  failures.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
}

/** True when `ip` has reached the ceiling within the active window.
 * `max` defaults to DEFAULT_MAX; callers that need a different cap
 * (the e2e runner raises the browser route's cap) pass it explicitly
 * so the shared tally stays a single per-IP store. */
export function isThrottled(ip: string, max: number = DEFAULT_MAX): boolean {
  const w = activeWindow(ip);
  return w !== undefined && w.count >= max;
}

/** Drop any tally for `ip` (called on a clean credential success). */
export function clearFailures(ip: string): void {
  failures.delete(ip);
}

/** Test-only: wipe every tally. Production code never calls this. */
export function _resetLoginThrottle(): void {
  failures.clear();
}

/** Test-only: number of entries currently in the failures Map.
 * Lets tests verify the sweep removed stale entries without
 * exposing Map internals to production callers. */
export function _loginThrottleSize(): number {
  return failures.size;
}
