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

/** Returns the live window for `ip`, dropping it first if it has
 * expired so a stale window never counts against a new attempt. */
function activeWindow(ip: string): FailureWindow | undefined {
  const w = failures.get(ip);
  if (!w) return undefined;
  if (w.resetAt <= Date.now()) {
    failures.delete(ip);
    return undefined;
  }
  return w;
}

/** Record one failed credential attempt for `ip`. Starts a fresh
 * window if there is none (or the previous one expired). */
export function recordFailure(ip: string): void {
  const w = activeWindow(ip);
  if (w) {
    w.count += 1;
    return;
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
