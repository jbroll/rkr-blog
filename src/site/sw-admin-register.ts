// Admin PWA service worker registration. Loaded as an external module
// from the admin template so it stays under the existing script-src
// 'self' CSP (no 'unsafe-inline' needed).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/static/site/sw-admin.js', { scope: '/admin/' })
    .catch((err: unknown) => {
      console.warn('rkroll admin sw register failed:', err);
    });
}
