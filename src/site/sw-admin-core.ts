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
  // It is also auth-gated, and add() rejects on a 401 — atomically
  // discarding every public asset alongside it. A miss here is repaired
  // by the first online navigation (see handleFetch).
  await cache.add(SHELL_URL).catch(() => {});
  return manifest.hash;
}

/** The one live cache. activate() evicts every other `rkr-admin-*`, so
 * a lookup by prefix finds the current build's. */
async function openCurrentCache(env: SwEnv): Promise<Cache | null> {
  const name = (await env.caches.keys()).find((n) => n.startsWith(CACHE_PREFIX));
  return name ? env.caches.open(name) : null;
}

async function cacheShell(env: SwEnv, res: Response): Promise<void> {
  const cache = await openCurrentCache(env);
  // Keyed by SHELL_URL whatever the navigation's path: the shell is
  // slug-independent, so one copy serves every /admin/view/*.
  if (cache) await cache.put(SHELL_URL, res);
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
 * go to the network untouched (/admin/api, /admin/posts, /admin/post-bundle
 * and friends — the outbox already owns their offline behavior). */
export function handleFetch(env: SwEnv, req: Request): Promise<Response> | null {
  const url = new URL(req.url);
  if (req.method !== 'GET') return null;

  if (isShellNavigation(url, req)) {
    // Network-first: online the author always gets the fresh server
    // render, so a stale bundle survives at most one launch.
    return env
      .fetch(req)
      .then(async (res) => {
        // Repairs an install whose shell add was refused; also keeps the
        // cached copy current with the deployed render. Awaited rather
        // than fired off, so respondWith's pending promise keeps the
        // worker alive until the write lands.
        if (res.ok) await cacheShell(env, res.clone()).catch(() => {});
        return res;
      })
      .catch(() => env.caches.match(SHELL_URL, { ignoreSearch: true }))
      .then((res) => res ?? new Response('offline', { status: 503 }));
  }

  if (url.pathname.startsWith('/admin/static/')) {
    // Immutable for a given hash, so a hit is always correct.
    return env.caches.match(req).then((hit) => hit ?? env.fetch(req));
  }

  return null;
}
