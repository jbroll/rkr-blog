// Minimal install-only service worker — satisfies the PWA install requirement.
// No caching strategy: the editor is fully client-side and offline-capable
// once the shell is loaded.
const sw = self as unknown as ServiceWorkerGlobalScope;
sw.addEventListener('install', () => sw.skipWaiting());
sw.addEventListener('activate', (e) => e.waitUntil(sw.clients.claim()));
sw.addEventListener('fetch', () => {});
