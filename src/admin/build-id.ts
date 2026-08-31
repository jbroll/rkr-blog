// The build this page was rendered from, stamped into the admin shell
// by src/templates/admin.ts.
//
// Read at drain time, never baked into an outbox entry: the bug this
// guards against is a stale RUNNING bundle, and an entry can outlive
// several launches.

import { BUILD_HEADER, BUILD_META_NAME } from '../lib/build-contract.ts';

/** Spread into a fetch's headers. Empty when the shell carries no
 * stamp — an older cached shell, or a page that isn't the admin shell
 * at all. The server treats a missing header as permissive, so that
 * degrades to the old behaviour. */
export function buildIdHeader(): Record<string, string> {
  if (typeof document === 'undefined') return {};
  const meta = document.querySelector<HTMLMetaElement>(`meta[name="${BUILD_META_NAME}"]`);
  return meta?.content ? { [BUILD_HEADER]: meta.content } : {};
}
