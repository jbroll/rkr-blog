// Optimistic-concurrency baseline for the commitImageEdit drain,
// mirroring savePost's X-Rkr-Last-Synced-At mechanism (admin.ts).
//
// The baseline is the sidecar file's mtime, captured by the client at
// edit-start (echoed from GET /admin/sidecar/:id/meta as `updatedAt`)
// and threaded through the queued outbox entry so it survives offline.
// A stale drained replay that arrives after a newer same-image edit
// landed must be REJECTED (409) instead of silently reverting the
// image; pure replays stay idempotent via the applied_outbox table +
// a byte-identical cheap no-op that run BEFORE this guard.
//
// Pure (no Fastify coupling) so both the /meta route and the commit
// handler can share the exact same mtime read + ms-granularity /
// future-clamp compare savePost uses.

import fs from 'node:fs';

import { canonicalJson } from '../lib/canonical-json.ts';
import { sidecarPath } from '../lib/sidecar.ts';
import type { Sidecar } from '../lib/sidecar-types.ts';

/** The sidecar's current updated_at (file mtime) as an ISO string, or
 * null when the sidecar file is absent. Echoed by /meta as the
 * client's edit-start baseline; re-read in the commit handler as the
 * server's current value to compare against. */
export function sidecarUpdatedAt(siteRoot: string, id: string): string | null {
  try {
    return new Date(fs.statSync(sidecarPath(siteRoot, id)).mtimeMs).toISOString();
  } catch (err) {
    /* c8 ignore next 2 -- ENOENT only; /meta + commit both 404 a
       missing sidecar before this is called */
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** True when the on-disk sidecar's ops + redoStack are canonically
 * identical to the incoming validated ops + redoStack. Reused for the
 * cheap pure-replay no-op (canonical compare, not fragile deep-equals,
 * so normalization key-order differences don't read as divergence). */
export function opsUnchanged(
  sidecar: Sidecar,
  incomingOps: unknown[],
  incomingRedo: unknown[]
): boolean {
  const diskRedo = sidecar.redoStack ?? [];
  return (
    canonicalJson(sidecar.ops) === canonicalJson(incomingOps) &&
    canonicalJson(diskRedo) === canonicalJson(incomingRedo)
  );
}

/** Optimistic-concurrency verdict for a drained commit, mirroring
 * savePost's mtime guard exactly (ms-granularity floor + future-clamp
 * of the client's claim). Returns:
 *  - 'no-baseline'  : header absent (legacy entry) → caller proceeds
 *                     (backward compatible, no 409).
 *  - 'invalid'      : header present but not an ISO-8601 timestamp.
 *  - 'superseded'   : sidecar advanced past the client's edit-start
 *                     baseline → caller returns 409.
 *  - 'ok'           : baseline still current → caller proceeds. */
export function evaluateSidecarBase(
  clientBaseRaw: string | string[] | undefined,
  siteRoot: string,
  id: string
):
  | { verdict: 'no-baseline' | 'invalid' | 'ok' }
  | { verdict: 'superseded'; serverUpdatedAt: string } {
  if (typeof clientBaseRaw !== 'string') return { verdict: 'no-baseline' };
  const clientBaseMs = Date.parse(clientBaseRaw);
  if (Number.isNaN(clientBaseMs)) return { verdict: 'invalid' };
  // Clamp the client's claim to "now" so clock skew / a malicious
  // client can't bypass the guard by claiming a future baseline.
  const clampedClientMs = Math.min(clientBaseMs, Date.now());
  let serverMtimeMs: number;
  try {
    serverMtimeMs = Math.floor(fs.statSync(sidecarPath(siteRoot, id)).mtimeMs);
  } catch (err) {
    /* c8 ignore next 2 -- sidecar existence is checked before this */
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { verdict: 'ok' };
    throw err;
  }
  // ms-granularity compare: mtimeMs is a sub-ms float on some
  // filesystems but the baseline round-trips through ms, so a sidecar
  // whose mtime matches the baseline (modulo nanosecond noise) must
  // not 409 against itself.
  if (serverMtimeMs > clampedClientMs) {
    return { verdict: 'superseded', serverUpdatedAt: new Date(serverMtimeMs).toISOString() };
  }
  return { verdict: 'ok' };
}
