// The logout landing (sw-unregister.ts) drops the editor's cached pages.
// It never touches page drafts: any link can reach the landing URL, so
// only a confirmed sign-out deletes them (admin-signout.ts).
//
// Imported by sw-unregister.ts alone. A module shared with sw-admin.ts
// becomes a split chunk, which the classic service worker cannot load.

/** sw-admin-core.ts CACHE_PREFIX; a test keeps the two equal. */
export const ADMIN_CACHE_PREFIX = 'rkr-admin-';

interface LandingEnv {
  caches?: Pick<CacheStorage, 'keys' | 'delete'>;
  serviceWorker?: {
    getRegistration(scope: string): Promise<{ unregister(): Promise<boolean> } | undefined>;
  };
}

/** Drop every admin cache and unregister the admin worker. */
export async function clearAdminCaches(env: LandingEnv): Promise<void> {
  for (const name of (await env.caches?.keys()) ?? []) {
    if (name.startsWith(ADMIN_CACHE_PREFIX)) await env.caches?.delete(name);
  }
  await (await env.serviceWorker?.getRegistration('/admin/'))?.unregister();
}
