// sha256 hex of canonicalJson(ops) — the X-Rkr-Bake-Ops-Hash
// header the server enforces (spec.md §7). Single helper used by
// the online bake POST, the offline bake-queue path, and the
// server's verification side.

import { canonicalJson } from './canonical-json.ts';
import type { SidecarOp } from './sidecar-types.ts';

export async function bakeOpsHash(ops: readonly SidecarOp[]): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(ops));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
