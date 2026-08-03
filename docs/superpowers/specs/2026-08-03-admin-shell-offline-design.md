# Admin Shell Offline Launch — Design Spec

**Date:** 2026-08-03
**Status:** Approved
**Scope:** Make `/admin/editor` and its assets service-worker cacheable so the
installed PWA launches with no network, and make a pinned or locally-created post
viewable offline in its published form. Replaces the "admin SPA is deliberately
not SW-cached" position in `docs/spec-offline.md` §3, and narrows the WYSIWYG
non-goal in `docs/spec.md:29`.

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

Launching is half of it. Once the PWA opens, everything it can show is editor
chrome: pinned posts and local drafts render in the ProseMirror surface, never as
the blog. `renderPostPage` is server-only, and the markdown-to-HTML step
(`renderPostHtml`, `src/lib/content.ts:104`) does filesystem work while rendering —
a widget reads a sidecar and measures an image mid-markup
(`src/widgets/figure.ts:91,130,148`), pulling `sharp` and `node:fs` into the render
path. So there is no route from OPFS content to published-looking HTML with the
network gone.

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

### 6. Published-form rendering: gather first, then render

`renderPostHtml` takes a map of image facts instead of a site root:

```ts
interface ImageSource {
  sidecar: Sidecar;
  width: number;
  height: number;
  urlFor(width: number, format: string, quality: number): string;
}

renderPostHtml(ast, { images: Map<string, ImageSource>, widgets })
```

The map is keyed by the id string as written in the post, so prefix resolution
happens while building it, where the full sidecar list is available. Everything the
renderer needs is then in hand before the first tag is emitted: widgets read from
the map, and `renderPostHtml`, `renderPostPage`, and `src/widgets/figure.ts` become
pure string work that bundles in either environment.

Each side builds the map its own way. The server scans the post for image ids
(`scanPostForImageIds`, `src/lib/posts.ts:46`), reads sidecars from disk, resolves
dimensions through `imageDimensions` / `ensureBake`, and gives `urlFor` a body that
closes over `cacheKey` to produce `/img/<id>.<oph>.<fmt>`. The client scans the same
way, reads sidecars and bakes from OPFS, and returns a `blob:` URL from `urlFor`,
collapsing the srcset to the one candidate it holds. `sharp`, `node:fs`, and
`node:crypto` stay in the server's half; the admin bundle gains no new dependency,
since `remark`, `remark-directive`, and `remark-frontmatter` are already there via
`src/lib/prose-markdown.ts:27-29`.

An injected port interface with the reads left in place was considered and
rejected: it wraps the filesystem calls rather than removing them, and leaves the
widgets async against an abstraction. Gathering first also lets the server resolve
every image concurrently instead of serially mid-render, and makes `renderPostHtml`
testable from a hand-written map with no stubs.

`src/lib/widget-helpers.ts` splits accordingly. `imageDimensions`, `ensureBake`, and
`applyOpsWithPerspective` move to the server prepass; `renderPicture`,
`wrapLightboxAnchor`, `extractImageIdsAndAlts`, `resolveIds`, `clampAlt`,
`splitAlts`, and `indent` stay. `getKnownIds` and its `WeakMap` cache
(`widget-helpers.ts:122-131`) are deleted — they exist only to memoize a repeated
`fs.readdirSync` that the prepass now does once.

`src/templates/layout.ts` gets the same treatment at a smaller scale: `siteHead()`
and `bundleVersion()` take `theme` and `buildHash` as arguments rather than calling
`themeName()` and `resolveGitHash()` (`layout.ts:24,53`). The server passes what it
reads today; the client passes the theme from the site snapshot below and the hash
from `precache.json`, along with the `/admin/static` base prefix §1 introduces — the
preview's stylesheets and icons must resolve inside the worker's scope like the rest
of the shell.

### 7. `/admin/view/:slug`

`/admin/preview/:id` is taken by the image-derivative redirect
(`src/routes/admin-image-lookup.ts:67`), so the preview route is
`/admin/view/:slug`.

It renders client-side even when online. The requirement is to see the post as it
stands, and a server render at that URL would show the last saved version rather
than the editor's current buffer — online and offline would disagree. One path
avoids that, and it keeps the server route trivial: `/admin/view/:slug` serves the
same shell `/admin/editor` already serves, and `src/admin/main.ts` branches on
`location.pathname` to boot the preview instead of the editor. No fourth esbuild
entry, no second shell to keep in sync, and no `renderPostPage` call on the server
for this route.

The shell is slug-independent — the slug comes from `location.pathname` at runtime.
The service worker therefore caches one shell and serves it for any `/admin/view/*`
navigation, so a post pinned but never previewed still opens offline. §4's
network-first navigation rule covers `/admin/view/*` on the same terms as
`/admin/editor`.

Content resolves through markdown in both cases:

```
OPFS draft (ProseDoc + frontmatter)  ─ proseToMarkdown ─┐
  or pinned manifest markdown        ─────────────────► ├─ remark ─► mdast
                                                        │
mdast ─ renderPostHtml(ast, {images, widgets}) ────────► bodyHtml
bodyHtml + chrome ─ renderPostPage ───────────────────► document
```

`proseToMarkdown` already runs client-side (`src/admin/save.ts:10`), so an unsaved
draft and a pinned post converge before rendering and need no second code path.

Comments are omitted (`showComments: false`). The thread is server data that pinning
does not pull, and pulling it would extend the post-bundle manifest — a sync-surface
change this does not need.

### 8. Site chrome snapshot

`renderPostPage` needs `SiteChrome` — site title, nav links, banner placement — plus
the theme name, and none of it is in OPFS: `opfs://meta/_root.json` holds only
`schemaVersion` and `deviceId`. The editor writes `opfs://meta/_site.json` with
those fields whenever it loads online. If it is absent, the preview falls back to
the default theme and the title from the pinned manifest.

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

The preview is only worth having if the two prepasses agree, and `dimensions` is
where they will not. The server recreates a missing bake with sharp (`ensureBake`);
the client cannot, and falls back to the pinned bake, then `sidecar.metadata`. For a
post whose ops changed offline, layout is slightly off until the bake syncs — the
same window `imageDimensions`' existing comment documents for the server. Accepted
rather than engineered against; the port-equivalence test below is what keeps the
gap from widening.

The signature change to `renderPostHtml` is the largest blast radius in this spec.
It touches every published-page caller (`src/routes/public.ts:272,403`), so a
mistake there breaks live pages rather than the offline path.

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
| `src/lib/content.ts` | `RenderCtx.siteRoot` → `images` map |
| `src/lib/widgets.ts` | `WidgetCtx.siteRoot` → `images` map |
| `src/lib/widget-helpers.ts` | `sharp` / `fs` half moves to the server prepass; `getKnownIds` deleted; `renderPicture` reads the map |
| `src/widgets/figure.ts` | Sidecar and dimension reads → map lookups |
| `src/routes/public.ts` | Build the image map before rendering |
| `src/admin/main.ts` | Boot the preview when the path is `/admin/view/…` |
| `src/routes/admin.ts` | `/admin/view/:slug` serves the editor shell |
| `docs/spec.md` | §29 non-goal narrows to WYSIWYG *inside the editor* |
| `docs/spec-offline.md` | §3 reversed: shell is cached, keyed by hash; published-form preview added to §1 goals |
| `docs/implementation.md` | §7 Apache alias for `/admin/static/` |
| `docs/DEFERRED.md` | Stale-bundle-drain item |

**New**

| File | Purpose |
|---|---|
| `scripts/gen-precache.ts` | Walks build output, writes `static/admin/precache.json` |
| `src/lib/image-map-fs.ts` | Server prepass: sidecars, dimensions, `/img/` URLs |
| `src/admin/image-map-opfs.ts` | Client prepass: OPFS sidecars and bakes, `blob:` URLs |
| `src/admin/preview-page.ts` | Renders a draft or pinned post into the published page |
| `test/site/sw-admin.test.ts` | Service worker unit tests |
| `test/lib/image-map-equivalence.test.ts` | Both prepasses render one fixture identically |

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

Published-form rendering:

- **Prepass equivalence.** One fixture post renders through both prepasses and the
  HTML matches except for image URLs. This is the check that keeps the preview
  honest as either side changes; everything else here is secondary to it.
- `renderPostHtml` renders a post from a hand-written image map with no filesystem
  access and no stubs.
- A post referencing an image by id prefix resolves through the map.
- The client prepass returns a `blob:` URL for a pinned image and a placeholder for
  one with no OPFS bytes.
- `dimensions` falls back to `sidecar.metadata` when the bake is missing.
- `/admin/view/<slug>` renders an unsaved draft with no network call.
- The preview omits the comment thread.
- Missing `_site.json` renders with the default theme and the manifest title.

Integration:

- `/admin/static/admin/main.js` and `/static/admin/main.js` serve identical bytes.
- `/admin/editor` HTML references only `/admin/static/...` assets.
- Published pages are byte-identical before and after the `renderPostHtml`
  signature change, over the existing post fixtures.

The existing offline-authoring suite (`test/admin/*`, 68 tests) must stay green —
this change adds a launch path and touches none of the OPFS or outbox logic.

---

## Out of scope

- Public page offline support. The public service worker was deleted in `12fcb6f`
  and is not being restored here.
- Comments in the published-form preview. They would extend the post-bundle
  manifest and the pin flow.
- WYSIWYG inside the editor itself. The published form is a separate view at
  `/admin/view/:slug`; the editing surface is unchanged.
- The drain-time version check described under Residual risk.
