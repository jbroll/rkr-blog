// Service worker logic, pure (no side-effect listeners). The thin
// event-listener glue in src/site/sw.ts imports this module and
// wires the handlers; this file is what test/site/sw-core.test.ts
// exercises with a mock CacheStorage.
//
// Three caches per spec-offline §9:
//   • rkr-shell-vN  shell assets (CSS, JS, manifest, icons) — SWR.
//   • rkr-pages-vN  /<slug> HTML pages, SWR with LRU cap; auth-
//                   sensitive responses (Cache-Control: no-store)
//                   are NOT cached so an authed view doesn't
//                   shadow the next anonymous load. sw-register
//                   posts {type:'rkr-pages-flush'} on login/logout
//                   to evict the whole cache.
//   • rkr-images-vN /img/<id>.<ophash>.<fmt> derivatives — cache-
//                   first (content-addressed, immutable by hash).
//
// Structural Cache / CacheStorage types are defined locally so this
// file typechecks under both tsconfig.browser.json (DOM + webworker
// libs, full Cache types) and tsconfig.json (es2023 only — tests
// run here). The real DOM types are structurally compatible.

/** Subset of the DOM Cache interface we use. */
export interface CacheLike {
  match(req: Request | string): Promise<Response | undefined>;
  put(req: Request | string, res: Response): Promise<void>;
  delete(req: Request | string): Promise<boolean>;
  keys(): Promise<readonly Request[]>;
  addAll(reqs: readonly (Request | string)[]): Promise<void>;
}

/** Subset of the DOM CacheStorage interface we use. */
export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  delete(name: string): Promise<boolean>;
  keys(): Promise<readonly string[]>;
  has(name: string): Promise<boolean>;
}

/** Bump when cache semantics change so the activate handler nukes
 * the old cache name. v3: SWR for navigations + the rkr-pages-flush
 * postMessage hook for auth-state invalidation. */
const VERSION = 'v3';
export const SHELL = `rkr-shell-${VERSION}`;
export const PAGES = `rkr-pages-${VERSION}`;
export const IMAGES = `rkr-images-${VERSION}`;
export const ALL_CACHES = [SHELL, PAGES, IMAGES];

/** LRU caps: visitors browse, they don't hoard. Tunable per
 * spec §16 Defaults; risk-free to change since they only matter
 * once the cache hits cap. */
export const PAGES_CAP = 50;
const IMAGES_CAP = 200;

/** site.css and JS bundles are versioned (`?v=<gitHash>` from the
 * templates), so each deploy is a distinct cache key — let SWR
 * populate them lazily. Icons + manifest are unversioned and safe
 * to precache. */
export const SHELL_PRECACHE: readonly string[] = [
  '/static/manifest.webmanifest',
  '/static/icon-192.png',
  '/static/icon-512.png'
];

/** Cache-first: serve from cache if present, else fetch + cache.
 * Used for /img/* derivatives — content-addressed URLs are immutable
 * by construction, so a hit is always correct. */
export async function cacheFirst(
  caches: CacheStorageLike,
  req: Request,
  cacheName: string,
  cap: number,
  doFetch: typeof fetch = fetch
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await doFetch(req);
  if (res.ok && res.status === 200) {
    void cacheWithCap(cache, req, res.clone(), cap);
  }
  return res;
}

/** Stale-while-revalidate: serve cached copy immediately if present,
 * fetch in the background and update the cache for the next visit.
 * Skips caching when the response carries `Cache-Control: …no-store…`
 * — that's the server's signal that the body is session-private and
 * must not survive into the next navigation. */
export async function staleWhileRevalidate(
  caches: CacheStorageLike,
  req: Request,
  cacheName: string,
  cap: number,
  doFetch: typeof fetch = fetch
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const network = doFetch(req)
    .then((res) => {
      if (!res.ok || res.status !== 200) return res;
      if (isNoStore(res)) {
        void cache.delete(req);
        return res;
      }
      void cacheWithCap(cache, req, res.clone(), cap);
      return res;
    })
    .catch((err) => {
      // Network down + nothing cached → re-throw so the page sees
      // a real failure instead of a "succeeded with empty body".
      if (!hit) throw err;
      return hit;
    });
  return hit ?? network;
}

/** Does the response opt out of caching via Cache-Control? Matches
 * `no-store` anywhere in the header value (case-insensitive). */
export function isNoStore(res: Response): boolean {
  const cc = res.headers.get('cache-control');
  if (!cc) return false;
  return /\bno-store\b/i.test(cc);
}

/** Add `req → res` to `cache`, then trim to the cap by deleting
 * the oldest entries. The Cache API doesn't expose true LRU, but
 * the spec (Service Workers — Cache#keys) guarantees `keys()`
 * returns entries in insertion order, so an age-based FIFO trim
 * works without tracking timestamps. A new put for an existing
 * key updates that key in place (not moved to the end), so this
 * is FIFO-by-first-insertion, not by last-access. That's the
 * right policy for content-addressed /img/* URLs (ophash never
 * collides) and acceptable for /static/* (versioned by deploy
 * hash). */
export async function cacheWithCap(
  cache: CacheLike,
  req: Request,
  res: Response,
  cap: number
): Promise<void> {
  await cache.put(req, res);
  if (!Number.isFinite(cap)) return;
  const keys = await cache.keys();
  const overflow = keys.length - cap;
  if (overflow > 0) {
    for (let i = 0; i < overflow; i++) {
      await cache.delete(keys[i] as Request);
    }
  }
}

/** Dispatch a fetch event by URL: returns a Response promise when
 * the SW should respond, or null when the request should pass
 * through to the network unmodified (admin / API / cross-origin
 * etc). Pure routing logic — fetch + cache plumbing happens inside
 * cacheFirst / staleWhileRevalidate. */
export function dispatchFetch(
  caches: CacheStorageLike,
  req: Request,
  swOrigin: string,
  doFetch: typeof fetch = fetch
): Promise<Response> | null {
  if (req.method !== 'GET') return null;
  const url = new URL(req.url);
  // Admin + API + debug: never cache. The OPFS layer is the offline
  // path for admin; intercepting here would shadow it.
  if (
    url.pathname.startsWith('/admin/') ||
    url.pathname === '/admin' ||
    url.pathname.startsWith('/_debug/')
  ) {
    return null;
  }
  // Same-origin only.
  if (url.origin !== swOrigin) return null;

  if (url.pathname.startsWith('/img/')) {
    return cacheFirst(caches, req, IMAGES, IMAGES_CAP, doFetch);
  }
  if (url.pathname.startsWith('/static/')) {
    return staleWhileRevalidate(caches, req, SHELL, Number.POSITIVE_INFINITY, doFetch);
  }
  // / and /:slug — rendered pages.
  return staleWhileRevalidate(caches, req, PAGES, PAGES_CAP, doFetch);
}

/** Install handler: prime the shell cache with the unversioned
 * static files (icons + manifest). Returns the promise the event
 * waitUntil() should hold. */
export async function runInstall(caches: CacheStorageLike): Promise<void> {
  const cache = await caches.open(SHELL);
  await cache.addAll(SHELL_PRECACHE);
}

/** Activate handler: nuke any rkr-* cache that isn't in ALL_CACHES
 * (i.e. left over from a prior VERSION). */
export async function runActivate(caches: CacheStorageLike): Promise<void> {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((n) => n.startsWith('rkr-') && !ALL_CACHES.includes(n))
      .map((n) => caches.delete(n))
  );
}

/** Message handler for the page-side `{type:'rkr-pages-flush'}`
 * sent by sw-register after a login/logout redirect. Drops the
 * entire PAGES cache so the next navigation re-fetches from the
 * network. Returns the deletion promise (waitUntil-friendly). */
export function runMessage(caches: CacheStorageLike, data: unknown): Promise<boolean> | null {
  const msg = data as { type?: string } | null;
  if (msg?.type !== 'rkr-pages-flush') return null;
  return caches.delete(PAGES);
}
