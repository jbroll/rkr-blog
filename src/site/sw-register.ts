// Public-page service worker registration. Inline registration would
// need a CSP nonce or 'unsafe-inline' for script-src; a separate file
// loaded as <script src="..."> stays under the existing script-src
// 'self' policy.
//
// Best-effort: registration failures (file 404, scope mismatch,
// browser without SW support) log + return. The SW is a strict
// progressive enhancement; the public site works without it.

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/static/site/sw.js', { scope: '/' }).catch((err) => {
    console.warn('rkroll sw register failed:', err);
  });
}
