// Constant-time comparison against the ADMIN_TOKEN env var. Used by both
// the bearer-header middleware (src/lib/auth-middleware.ts) and the
// browser token-login route (src/routes/auth.ts).
//
// Lives in its own module to keep src/routes/auth.ts and
// src/lib/auth-middleware.ts on a one-way import edge — middleware
// already imports SESSION_COOKIE_NAME from src/lib/session-constants.ts,
// so adding a reverse edge would create a cycle.

import { timingSafeEqual } from 'node:crypto';

/** Returns true iff `provided` byte-for-byte equals process.env.ADMIN_TOKEN.
 * Returns false when ADMIN_TOKEN is unset or empty. */
export function adminTokenMatchesEnv(provided: string): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  // timingSafeEqual requires equal-length buffers. Length-pad both sides
  // to the same length so an attacker can't probe expected-length via
  // an early-return; compare the result AND the lengths.
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
