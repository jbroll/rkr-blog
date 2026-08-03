// Admin PWA cache logic, kept out of sw-admin.ts so it can be unit
// tested in Node: CacheStorage and fetch arrive as parameters rather
// than off `self`.
//
// One cache per build hash means new HTML can never pair with old
// chunks — the drift that kept the shell uncached before.

export const CACHE_PREFIX = 'rkr-admin-';
export const PRECACHE_URL = '/admin/static/admin/precache.json';
export const SHELL_URL = '/admin/editor';

export interface SwEnv {
  caches: CacheStorage;
  fetch: typeof fetch;
}

interface Precache {
  hash: string;
  assets: string[];
}

export async function precacheInstall(env: SwEnv): Promise<string> {
  const res = await env.fetch(PRECACHE_URL, { cache: 'no-store' });
  const manifest = (await res.json()) as Precache;
  const cache = await env.caches.open(CACHE_PREFIX + manifest.hash);
  await cache.addAll(manifest.assets);
  // The shell is a server render, not a build artifact, so it isn't in
  // the manifest; one cached copy serves every /admin/view/* slug too.
  await cache.add(SHELL_URL);
  return manifest.hash;
}

export async function evictOldCaches(env: SwEnv, keep: string): Promise<string[]> {
  const current = CACHE_PREFIX + keep;
  const stale = (await env.caches.keys()).filter(
    (name) => name.startsWith(CACHE_PREFIX) && name !== current
  );
  for (const name of stale) await env.caches.delete(name);
  return stale;
}

function isShellNavigation(url: URL, req: Request): boolean {
  if (req.mode !== 'navigate') return false;
  return url.pathname === SHELL_URL || url.pathname.startsWith('/admin/view/');
}

/** Returns the response promise to serve, or null to let the request
 * go to the network untouched (/admin/api, /admin/sync, /admin/post-bundle
 * and friends — the outbox already owns their offline behavior). */
export function handleFetch(env: SwEnv, req: Request): Promise<Response> | null {
  const url = new URL(req.url);
  if (req.method !== 'GET') return null;

  if (isShellNavigation(url, req)) {
    // Network-first: online the author always gets the fresh server
    // render, so a stale bundle survives at most one launch.
    return env
      .fetch(req)
      .catch(() => env.caches.match(SHELL_URL, { ignoreSearch: true }))
      .then((res) => res ?? new Response('offline', { status: 503 }));
  }

  if (url.pathname.startsWith('/admin/static/')) {
    // Immutable for a given hash, so a hit is always correct.
    return env.caches.match(req).then((hit) => hit ?? env.fetch(req));
  }

  return null;
}
