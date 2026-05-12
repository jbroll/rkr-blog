// Public-side service worker. Registered from src/templates/post.ts
// + src/templates/index.ts (NOT from the admin SPA — admin offline
// goes through OPFS, see spec-offline.md §3).
//
// Three caches per spec-offline §9:
//   • rkr-shell-vN  shell assets (CSS, JS, manifest, icons) — stale-
//                   while-revalidate
//   • rkr-pages-vN  /<slug> HTML pages, runtime-populated, stale-
//                   while-revalidate with an LRU cap so a long
//                   browse history doesn't hoard storage. Because
//                   the markup depends on session state (FABs,
//                   footer Login/Logout link), the auth routes
//                   redirect through ?_rkr=login|logout — a cache-
//                   busting param the SW has never cached against
//                   so the navigation always reaches the network.
//                   sw-register.js spots that param on load, strips
//                   it via history.replaceState, and posts a
//                   {type:'rkr-pages-flush'} message to the SW so
//                   the older stale-anonymous / + /:slug entries
//                   get dropped before the next in-app navigation.
//   • rkr-images-vN /img/<id>.<ophash>.<fmt> derivatives — cache-first
//                   (content-addressed by the ophash; once cached, it
//                   matches forever or is evicted)
//
// Admin routes, OAuth callbacks, and /admin/* API are NOT intercepted;
// the SW falls through to network. Public reads only.

// `self` resolves to Window under tsconfig.browser.json's combined
// dom+webworker libs; cast once to the SW global type so addEventListener
// + skipWaiting + clients all type-check.
const sw = self as unknown as ServiceWorkerGlobalScope;

// Bump when cache semantics change so the activate handler nukes
// the old cache name. v3: SWR for navigations is back, but the
// auth flow now invalidates the PAGES cache through a postMessage
// hook (see the 'message' listener below) so v1-era stale anon
// renders that survived a login don't keep shadowing the authed
// chrome.
const VERSION = 'v3';
const SHELL = `rkr-shell-${VERSION}`;
const PAGES = `rkr-pages-${VERSION}`;
const IMAGES = `rkr-images-${VERSION}`;
const ALL_CACHES = [SHELL, PAGES, IMAGES];

// LRU caps: visitors browse, they don't hoard. Tunable per the spec's
// §16 "Defaults" table; values matter only when the cache hits the
// cap, so changing them is risk-free.
const PAGES_CAP = 50;
const IMAGES_CAP = 200;

// site.css and the JS bundles are referenced as `path?v=<gitHash>` from
// the templates (so each deploy is a distinct cache key); the precache
// can't know the hash, so we let SWR populate them on first navigation.
// The icons + manifest stay un-versioned, so they're safe to precache.
const SHELL_PRECACHE: readonly string[] = [
  '/static/manifest.webmanifest',
  '/static/icon-192.png',
  '/static/icon-512.png'
];

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_PRECACHE))
      .then(() => sw.skipWaiting())
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('rkr-') && !ALL_CACHES.includes(n))
          .map((n) => caches.delete(n))
      );
      await sw.clients.claim();
    })()
  );
});

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Admin + API + auth: never cache. The OPFS layer is the offline
  // path for admin; intercepting here would shadow it. /admin/login
  // is the one carve-out — it's the GET form that anonymous visitors
  // hit, the response body is identical for every visitor, and
  // letting the SW SWR-cache it makes reloads instant (otherwise the
  // network round-trip exposes a brief unstyled-content frame
  // between the inline pre-paint and external CSS arriving).
  if (
    (url.pathname.startsWith('/admin/') && url.pathname !== '/admin/login') ||
    url.pathname === '/admin' ||
    url.pathname.startsWith('/_debug/')
  ) {
    return;
  }
  // Same-origin only. Cross-origin (e.g. apis.google.com) passes
  // through.
  if (url.origin !== sw.location.origin) return;

  // /img/<id>.<ophash>.<fmt> — content-addressed, cache-first.
  if (url.pathname.startsWith('/img/')) {
    event.respondWith(cacheFirst(req, IMAGES, IMAGES_CAP));
    return;
  }

  // /static/* — stale-while-revalidate. The shell precache covers
  // the well-known assets; runtime fetches (e.g. an unhashed bundle
  // path) fall here too.
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(staleWhileRevalidate(req, SHELL, /* cap */ Number.POSITIVE_INFINITY));
    return;
  }

  // / and /:slug — rendered pages. SWR with cap so a long browse
  // history doesn't eat the visitor's storage. The server marks
  // authed responses with `Cache-Control: private, no-store`; the
  // SWR helper honours it and skips caching so an authed view
  // doesn't shadow the next anonymous load (and vice versa). On
  // login/logout the page-side hook (sw-register.ts) posts
  // {type:'rkr-pages-flush'} so any stale-from-the-other-side
  // entries are dropped before the visitor's next click.
  event.respondWith(staleWhileRevalidate(req, PAGES, PAGES_CAP));
});

// Page-side hook: sw-register.ts posts this on every load that
// arrives with ?_rkr=login|logout (i.e. the redirect target after
// an auth state change). Drop the entire PAGES cache so the next
// navigation to / or /:slug re-fetches from the network instead
// of serving the stale-from-the-other-side SWR hit.
sw.addEventListener('message', (event) => {
  const data = event.data as { type?: string } | null;
  if (data?.type !== 'rkr-pages-flush') return;
  event.waitUntil(caches.delete(PAGES));
});

/** Cache-first: serve from cache if present, else fetch + cache.
 * Used for /img/* derivatives — content-addressed URLs are immutable
 * by construction, so a hit is always correct. */
async function cacheFirst(req: Request, cacheName: string, cap: number): Promise<Response> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.status === 200) {
    void cacheWithCap(cache, req, res.clone(), cap);
  }
  return res;
}

/** Stale-while-revalidate: serve cached copy immediately if present,
 * fetch in the background and update the cache for the next visit.
 * If nothing's cached yet, fall through to network. Skips caching
 * when the response carries `Cache-Control: …no-store…` — that's
 * the server's signal that the body is session-private and must
 * not survive into the next navigation. Used for /static/* where
 * the URL is versioned (so freshness isn't a concern) and the
 * speedup from cached delivery is meaningful. */
async function staleWhileRevalidate(
  req: Request,
  cacheName: string,
  cap: number
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const network = fetch(req)
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
function isNoStore(res: Response): boolean {
  const cc = res.headers.get('cache-control');
  if (!cc) return false;
  return /\bno-store\b/i.test(cc);
}

/** Add `req → res` to `cache`, then trim to the cap by deleting the
 * oldest entries (FIFO via insertion order, since the Cache API
 * doesn't expose true LRU semantics). */
async function cacheWithCap(cache: Cache, req: Request, res: Response, cap: number): Promise<void> {
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
