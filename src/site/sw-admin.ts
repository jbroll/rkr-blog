// Minimal admin service worker. Satisfies the browser PWA install
// requirement. The editor works offline via OPFS — no caching needed here.
const sw = self as unknown as ServiceWorkerGlobalScope;
sw.addEventListener('install', () => sw.skipWaiting());
sw.addEventListener('activate', (e) => e.waitUntil(sw.clients.claim()));
sw.addEventListener('fetch', () => {});
