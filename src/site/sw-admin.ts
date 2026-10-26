// Admin PWA service worker. Precaches the editor bundle and its assets
// into a cache keyed by the build hash, and keeps the last online render
// of each opened page, so the block editor opens with no network
// (docs/spec-offline.md §3).

import {
  EDITOR_SAVED,
  evictOldCaches,
  handleFetch,
  precacheInstall,
  refreshCachedPage,
  type SwEnv
} from './sw-admin-core.ts';

const sw = self as unknown as ServiceWorkerGlobalScope;
const env: SwEnv = { caches: sw.caches, fetch: (...args) => sw.fetch(...args) };

sw.addEventListener('install', (e) => {
  e.waitUntil(precacheInstall(env).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    precacheInstall(env)
      .then((hash) => evictOldCaches(env, hash))
      .then(() => sw.clients.claim())
  );
});

sw.addEventListener('fetch', (e) => {
  const res = handleFetch(env, e.request);
  if (res) e.respondWith(res);
});

sw.addEventListener('message', (e) => {
  const data = e.data as { type?: unknown; path?: unknown } | null;
  if (data?.type !== EDITOR_SAVED) return;
  e.waitUntil(refreshCachedPage(env, sw.location.origin, data.path));
});
