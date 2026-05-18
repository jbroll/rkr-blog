// Anon-page service worker cleanup. Included on all public pages when
// the visitor is not authenticated (isAdmin is falsy). Two jobs:
//
// 1. Strip the ?_rkr=login|logout cache-bust param appended by auth
//    routes on redirect (same as sw-register.ts; must happen before
//    unregister so the flush postMessage fires to the still-active
//    controller, if any).
// 2. Unregister any SW from a previous deploy so casual readers
//    don't retain offline caching they no longer need.

{
  const url = new URL(location.href);
  if (url.searchParams.has('_rkr')) {
    url.searchParams.delete('_rkr');
    const clean = url.pathname + (url.search ? url.search : '') + url.hash;
    history.replaceState(null, '', clean);
    navigator.serviceWorker?.controller?.postMessage({ type: 'rkr-pages-flush' });
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistration('/')
    .then((reg) => reg?.unregister())
    .catch(() => {});
}
