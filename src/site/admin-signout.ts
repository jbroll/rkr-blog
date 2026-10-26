// After sign-out a shared device must not keep cached editor pages or
// unsent drafts. Runs on the page the logout redirect lands on
// (sw-unregister.ts). It must not import sw-admin-core.ts: a module shared
// with sw-admin.ts becomes a split chunk, and the classic service worker
// cannot load one.

import { DRAFTS_DB } from '../admin/unified-draft.ts';

/** sw-admin-core.ts CACHE_PREFIX; a test keeps the two equal. */
export const ADMIN_CACHE_PREFIX = 'rkr-admin-';

interface SignOutEnv {
  caches?: Pick<CacheStorage, 'keys' | 'delete'>;
  indexedDB?: { deleteDatabase(name: string): unknown };
  serviceWorker?: {
    getRegistration(scope: string): Promise<{ unregister(): Promise<boolean> } | undefined>;
  };
}

/** Drop every admin cache and the drafts database, and unregister the
 * admin worker. */
export async function clearAdminState(env: SignOutEnv): Promise<void> {
  for (const name of (await env.caches?.keys()) ?? []) {
    if (name.startsWith(ADMIN_CACHE_PREFIX)) await env.caches?.delete(name);
  }
  env.indexedDB?.deleteDatabase(DRAFTS_DB);
  await (await env.serviceWorker?.getRegistration('/admin/'))?.unregister();
}
