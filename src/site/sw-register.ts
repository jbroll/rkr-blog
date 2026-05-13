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

// Post-auth landing arrives with ?_rkr=login|logout — a cache-
// busting query param the auth routes append so the immediate
// navigation can't be served by an SWR hit. Once we're here, the
// session has flipped; drop the busy-buster from the URL so it
// doesn't get bookmarked, and ask the SW to flush its PAGES cache
// so the *next* in-app navigation also bypasses the stale-from-
// the-other-side entries. Best-effort: no SW controller (first
// load, SW not yet activated) → just strip the param.
{
  const url = new URL(location.href);
  if (url.searchParams.has('_rkr')) {
    url.searchParams.delete('_rkr');
    const clean = url.pathname + (url.search ? url.search : '') + url.hash;
    history.replaceState(null, '', clean);
    // postMessage to the controlling SW is same-origin by construction
    // (a SW is registered against its own origin's scope and only
    // controls navigations rooted there). sw-core.ts:runMessage only
    // acts on `type === 'rkr-pages-flush'` and ignores all else, so
    // even a hypothetical message from another tab same-origin sender
    // is harmless. No origin check needed here.
    navigator.serviceWorker?.controller?.postMessage({ type: 'rkr-pages-flush' });
  }
}
