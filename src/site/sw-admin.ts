// Admin PWA service worker. Precaches the shell + its assets into a
// cache keyed by the build hash so the installed app launches with no
// network (docs/spec-offline.md §3).

import { evictOldCaches, handleFetch, precacheInstall, type SwEnv } from './sw-admin-core.ts';

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
