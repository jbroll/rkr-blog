// sha256 hex of canonicalJson(ops) — the value the bake-ops-hash
// guard (spec.md §7) expects in the X-Rkr-Bake-Ops-Hash header.
//
// Three callers compute it: src/admin/canvas-loaders.ts:uploadBake
// (online bake POST), src/admin/image-edit.ts:queueOpsAndBake
// (offline outbox queue → drained later), and the server itself
// in src/routes/admin-sidecar-edit.ts (verification side). Moving
// the helper to src/lib/ keeps a single canonical implementation
// + lets c8 measure it.

import { canonicalJson } from './canonical-json.ts';
import type { SidecarOp } from './sidecar-types.ts';

/** sha256 hex of canonicalJson(ops). Async because SubtleCrypto's
 * digest is async; both browser and Node 22+ expose it. */
export async function bakeOpsHash(ops: readonly SidecarOp[]): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(ops));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
