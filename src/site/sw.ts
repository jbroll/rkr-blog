// Public-side service worker. Registered from src/templates/post.ts
// + src/templates/index.ts (NOT from the admin SPA — admin offline
// goes through OPFS, see spec-offline.md §3).
//
// Thin event-listener wiring. The cache-strategy + URL-routing
// logic lives in src/site/sw-core.ts so it can be unit-tested in
// Node with a mocked CacheStorage (test/site/sw-core.test.ts).
// This file is the SW glue: register listeners, call into core.

import { dispatchFetch, runActivate, runInstall, runMessage } from './sw-core.ts';

// `self` resolves to Window under tsconfig.browser.json's combined
// dom+webworker libs; cast once to the SW global type so addEventListener
// + skipWaiting + clients all type-check.
const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener('install', (event) => {
  event.waitUntil(runInstall(caches).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(runActivate(caches).then(() => sw.clients.claim()));
});

sw.addEventListener('fetch', (event) => {
  const handled = dispatchFetch(caches, event.request, sw.location.origin);
  if (handled) event.respondWith(handled);
});

sw.addEventListener('message', (event) => {
  const task = runMessage(caches, event.data);
  if (task) event.waitUntil(task);
});
