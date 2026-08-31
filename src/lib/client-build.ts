// The stale-client guard for the drain routes (spec-offline §6).
//
// A client launched offline boots the CACHED admin shell and its
// cached bundle. Network-first navigation narrows that window to one
// launch but does not close it: the drain fires from the online-state
// listener the moment connectivity returns, with no navigation in
// between to refresh the shell. If the server was redeployed in the
// meantime, an old bundle writes through a contract it no longer
// matches.
//
// Every write that carries queued offline work sends the build its
// page was rendered from; a mismatch is refused so the author reloads
// rather than writing through a stale contract.

import { shortGitHash } from './build-info.ts';

export const BUILD_HEADER = 'x-rkr-build';

/** 426 Upgrade Required, not 409: `/admin/posts` already spends 409
 * on post-superseded and the client branches on it. */
export const STALE_CLIENT_STATUS = 426;

export interface StaleClient {
  error: 'stale-client';
  serverBuild: string;
}

/** The mismatch to reply with, or null to let the write proceed.
 *
 * A missing header is permissive on purpose: entries queued before
 * this field existed, the WordPress importer, and any scripted client
 * send none, and none of them are the stale-bundle case. So is a
 * server that cannot resolve its own hash — outside a git checkout
 * `resolveGitHash` returns 'unknown', and refusing every write on
 * that basis would be worse than the drift it guards against. */
export function staleClientRejection(
  header: unknown,
  serverBuild = shortGitHash()
): StaleClient | null {
  if (typeof header !== 'string' || header === '') return null;
  if (serverBuild === 'unknown' || serverBuild === header) return null;
  return { error: 'stale-client', serverBuild };
}
