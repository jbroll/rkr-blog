# Admin Shell Offline Launch — Design Spec

**Date:** 2026-08-03
**Status:** Approved
**Scope:** Make `/admin/editor` and its assets service-worker cacheable so the
installed PWA launches with no network. Replaces the "admin SPA is deliberately
not SW-cached" position in `docs/spec-offline.md` §3.

---

## Problem

Offline authoring works only inside an already-loaded tab. `src/site/sw-admin.ts`
is a six-line no-op — `install`, `activate`, and a `fetch` handler with an empty
body — that exists solely to satisfy the browser's PWA install requirement. It
caches nothing.

So launching the installed PWA offline fails. `static/admin-manifest.webmanifest`
points `start_url` at `/admin/editor`, which is server-rendered HTML plus a bundle
from `/static/admin/main.js`. With no network and nothing cached there is no page.
A hard reload of an open editor fails the same way. Draft content survives in OPFS,
but the author cannot reach it.

`docs/spec-offline.md:83-85` states this was deliberate: caching the shell risks a
stale bundle talking to a fresh server. That reasoning stands, but the mitigation
chosen — cache nothing — costs the offline launch entirely. Keying the cache to the
build hash addresses the drift without that cost.

---

## Constraints

**Service worker scope.** `src/site/sw-admin-register.ts` registers at
`scope: '/admin/'`, permitted by the `Service-Worker-Allowed: /admin/` header
`src/routes/admin.ts:98-103` sets on `sw-admin.js`. A service worker intercepts
fetches only within its scope. It can *cache* `/static/*`, but its `fetch` handler
never fires for those requests, so offline they still hit the network and fail.

Widening scope to `/` is not available: public pages load `sw-unregister.js`
(`src/templates/post.ts:91`, `index.ts:108`, `search.ts:61`, `not-found.ts:31`)
precisely to destroy any service worker at `/`. A root-scoped admin worker would be
killed by the next public page visit.

**Generated chunk names.** `build:admin` runs esbuild with `--splitting`, so chunk
filenames are not knowable when writing the worker. The precache list must be
generated at build time.

**Production static serving.** In production Apache serves `/static/*` directly
(`src/routes/admin.ts:63`, `docs/implementation.md` §7); `fastify-static` handles it
only in dev. Any new URL prefix needs a matching Apache alias.

---

## Approach

### 1. Bring the assets into scope

Register a second `fastify-static` at prefix `/admin/static/` against the same
`staticDir`, alongside the existing `/static/` registration in
`src/routes/admin.ts`. Change `src/templates/admin.ts` to reference
`/admin/static/...` for the admin bundle, `main.css`, the theme stylesheets from
`stylesheetLinks()`, `headIcons()`, and the webmanifest.

Everything the shell needs then sits under `/admin/`: the navigation and its
assets. Public pages continue to load their assets from `/static/*` and keep
unregistering at `/`, with no overlap.

`stylesheetLinks()` and `headIcons()` in `src/templates/layout.ts` are shared with
public templates, so they take an optional base-prefix argument defaulting to
`/static` — public callers are unchanged, the admin template passes `/admin/static`.

### 2. Build-generated precache list

`build:admin` gains a step writing `static/admin/precache.json`:

```json
{ "hash": "<12-char git hash>", "assets": ["/admin/static/admin/main.js", "..."] }
```

Contents: every file esbuild emits under `static/admin/` (splitting chunks
included), `main.css`, `base.css`, **all** of `static/themes/*.css`, the icons, and
`admin-manifest.webmanifest`. The hash comes from `resolveGitHash()`, the same
source `bundleVersion()` uses.

All theme sheets are precached rather than just the active one: the theme is
runtime config (`config/site.json#theme`, `src/lib/config.ts:296`) and is not
knowable at build time. The sheets are 57–91 lines each, so precaching all eight
costs less than the machinery to resolve one.

Sourcemaps are excluded — they are large and never needed offline.

Each entry carries the `?v=<hash>` suffix `bundleVersion()` stamps on the URL in the
rendered HTML. Cache keys include the query string, so a precache entry without it
would never match the request the page actually makes.

### 3. Cache keyed by build hash

`src/site/sw-admin.ts` grows from the no-op to:

- **install** — fetch `precache.json`, `cache.addAll()` its assets into
  `rkr-admin-<hash>`, then `skipWaiting()`.
- **activate** — delete every `rkr-admin-*` cache whose hash is not the current
  one, then `clients.claim()`.

A cache therefore only ever holds one exact build. There is no path by which new
HTML pairs with old chunks, which is the drift `docs/spec-offline.md:83-85` names.

### 4. Fetch strategy

- **Navigation to `/admin/editor`** — network-first, falling back to cache. Online
  the author always gets the fresh server render; offline they get the last good
  shell.
- **`/admin/static/*`** — cache-first. These are immutable for a given hash, so a
  hit is always correct. Miss falls through to network.
- **Everything else under `/admin/`** (`/admin/api/*`, `/admin/sync/*`,
  `/admin/post-bundle/*`) — no interception. These are live server calls; the
  outbox already handles their offline behavior.

Cache-first on the navigation was considered and rejected: it launches faster but
lets a stale bundle run against a fresh server indefinitely.

### 5. CSP nonce

`/admin/editor` stamps a per-response nonce onto its inline `<style>` block
(`src/routes/admin.ts:109-115`). A cached `Response` carries its own headers, so a
cached shell keeps the nonce matching its own cached CSP header. This is why the
whole response is cached rather than re-synthesized, and why no nonce change is
needed.

---

## Residual risk

Launching offline runs the last-cached bundle. If the server has since moved on,
the outbox drains from a stale client on reconnect. Network-first on the navigation
narrows the window to a single launch but does not close it.

Closing it means a version check at drain time — `/admin/sync/*` rejecting entries
stamped with a build hash the server no longer serves, and the client reloading.
That is a change to the sync contract and out of scope here. It goes in
`docs/DEFERRED.md` as: _offline-launched client can drain a stale bundle to a newer
server; revisit when a sync-breaking schema change ships._

---

## Files

**Changed**

| File | Change |
|---|---|
| `src/site/sw-admin.ts` | No-op → precache on install, hash-eviction on activate, network-first navigation + cache-first assets |
| `src/routes/admin.ts` | Second `fastify-static` at `/admin/static/` |
| `src/templates/admin.ts` | Asset references → `/admin/static/...` |
| `src/templates/layout.ts` | `stylesheetLinks()` / `headIcons()` take an optional base prefix, default `/static` |
| `package.json` | `build:admin` emits `precache.json` |
| `docs/spec-offline.md` | §3 reversed: shell is cached, keyed by hash |
| `docs/implementation.md` | §7 Apache alias for `/admin/static/` |
| `docs/DEFERRED.md` | Stale-bundle-drain item |

**New**

| File | Purpose |
|---|---|
| `scripts/gen-precache.ts` | Walks build output, writes `static/admin/precache.json` |
| `test/site/sw-admin.test.ts` | Service worker unit tests |

---

## Testing

Unit (`node --test`, per `package.json:19`):

- Precache manifest lists every file the build emits under `static/admin/`,
  excluding sourcemaps, and every entry carries the `?v=` suffix.
- Every theme sheet in `static/themes/` appears in the manifest.
- `activate` deletes caches for foreign hashes and keeps the current one.
- Navigation request falls back to cache when `fetch` rejects.
- Navigation request prefers network when `fetch` resolves.
- `/admin/static/*` is served from cache without a network call on a hit.
- `/admin/api/*` is not intercepted.

Integration:

- `/admin/static/admin/main.js` and `/static/admin/main.js` serve identical bytes.
- `/admin/editor` HTML references only `/admin/static/...` assets.

The existing offline-authoring suite (`test/admin/*`, 68 tests) must stay green —
this change adds a launch path and touches none of the OPFS or outbox logic.

---

## Out of scope

- Public page offline support. The public service worker was deleted in `12fcb6f`
  and is not being restored here.
- Previewing a post in its published form offline. `renderPostPage` stays
  server-only; `docs/spec.md:29` keeps it a non-goal.
- The drain-time version check described under Residual risk.
