// Admin PWA cache logic, kept out of sw-admin.ts so it can be unit
// tested in Node: CacheStorage and fetch arrive as parameters rather
// than off `self`.
//
// One cache per build hash means new HTML can never pair with old
// chunks — the drift that kept the shell uncached before.

export const CACHE_PREFIX = 'rkr-admin-';
export const PRECACHE_URL = '/admin/static/admin/precache.json';
export const EDITOR_SAVED = 'rkr-editor-saved';

const EDIT_PAGE = /^\/admin\/blocks\/edit\/(?:_footer|[a-z0-9-]+)$/;
const MACROS_URL = '/admin/blocks/macros';

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
  return manifest.hash;
}

/** The one live cache. activate() evicts every other `rkr-admin-*`, so
 * a lookup by prefix finds the current build's. */
async function openCurrentCache(env: SwEnv): Promise<Cache | null> {
  const name = (await env.caches.keys()).find((n) => n.startsWith(CACHE_PREFIX));
  return name ? env.caches.open(name) : null;
}

export async function evictOldCaches(env: SwEnv, keep: string): Promise<string[]> {
  const current = CACHE_PREFIX + keep;
  const stale = (await env.caches.keys()).filter(
    (name) => name.startsWith(CACHE_PREFIX) && name !== current
  );
  for (const name of stale) await env.caches.delete(name);
  return stale;
}

/** Server-rendered admin pages that must open offline. Pages and the
 * macro list are auth-gated renders, so they are cached on the way
 * through rather than precached. */
function isNetworkFirst(url: URL, req: Request): boolean {
  if (url.pathname === MACROS_URL) return true;
  if (req.mode !== 'navigate') return false;
  return url.pathname === '/admin/blocks' || EDIT_PAGE.test(url.pathname);
}

/** Network-first, keyed by path; offline, any query falls back to it. */
async function networkFirst(env: SwEnv, req: Request, key: string): Promise<Response> {
  try {
    const res = await env.fetch(req);
    // A query render (a filtered pages list) must not replace the full copy.
    // Awaited so respondWith keeps the worker alive until the write lands.
    if (res.ok && !new URL(req.url).search) {
      await putCurrent(env, key, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    const hit = await env.caches.match(key, { ignoreSearch: true });
    return hit ?? new Response('offline', { status: 503 });
  }
}

async function putCurrent(env: SwEnv, key: string, res: Response): Promise<void> {
  const cache = await openCurrentCache(env);
  if (cache) await cache.put(key, res);
}

/** Re-cache an editor page after a save, so an offline reload doesn't
 * show the pre-save tree and then save over the newer version. */
export async function refreshCachedPage(env: SwEnv, origin: string, path: unknown): Promise<void> {
  if (typeof path !== 'string' || !EDIT_PAGE.test(path)) return;
  const key = origin + path;
  try {
    const res = await env.fetch(key, { credentials: 'same-origin' });
    if (res.ok) await putCurrent(env, key, res);
  } catch {
    // Offline: the next online open refreshes it.
  }
}

/** Returns the response promise to serve, or null to let the request
 * go to the network untouched (saves, uploads, sync drains — the outbox
 * and the editor's draft store own their offline behavior). */
export function handleFetch(env: SwEnv, req: Request): Promise<Response> | null {
  const url = new URL(req.url);
  if (req.method !== 'GET') return null;

  if (isNetworkFirst(url, req)) return networkFirst(env, req, url.origin + url.pathname);

  if (url.pathname.startsWith('/admin/static/')) {
    // Immutable for a given hash, so a hit is always correct.
    return env.caches.match(req).then((hit) => hit ?? env.fetch(req));
  }

  return null;
}
