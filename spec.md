# rkroll-cms — Feature specification

What the application does. Implementation-agnostic — an alternate stack
should be able to reproduce the application from this document.

For HOW this codebase delivers it, see [implementation.md](./implementation.md).
For local development setup, see [developer-quickstart.md](./developer-quickstart.md).

---

## 1. Goals

- Static markdown is the canonical content format. Custom widget blocks
  (images, galleries, carousels, diptychs/triptychs) are markdown
  directives, not HTML.
- The editor never exposes markdown syntax to the author.
- Image pipeline retains the unmodified master forever, records edits
  declaratively, and serves cached derivatives.
- Imports from local upload, plain URL, Google Drive, OneDrive, Dropbox.
- Lazy derivative rendering by default; full pre-render available as an
  explicit operator action.
- Single author. No multi-user features in v1.

## 2. Non-goals

- Plugin / theme marketplace.
- Multi-tenant operation.
- Real-time collaboration.
- WYSIWYG fidelity to the published theme inside the editor (preview
  is not the published page).

## 3. Architecture (behavioral)

```
client ──▶ front proxy ──▶ rendered derivative on disk (fast path)
                       ──▶ static assets on disk
                       ──▶ application server (everything else)
```

The fast path is the contract: once a derivative URL has been served
once, subsequent requests for the same URL bypass the application
server entirely and stream from disk with long-cache headers.
Application server is invoked only on cache miss, admin routes, and
API endpoints.

## 4. Runtime data layout

The deployed application owns a tree of state outside the codebase:

| location | content | properties |
|---|---|---|
| originals | one master file per logical image, content-addressed by sha256 | write-once; re-importing identical bytes is a no-op |
| sidecars | one JSON per logical image; the editing-state record | mutable; primary truth for op chain + redo stack |
| bakes | one client-baked post-ops image per id | optional; reproducible from original + sidecar |
| derivatives cache | per-format, per-variant rendered images | reproducible; safe to delete |
| posts | one markdown file per post | canonical content source |
| index DB | post index, jobs, sessions, OAuth | reproducible from posts (index) + filesystem (jobs); sessions and OAuth tokens are not reproducible |

Backup set: originals, sidecars, posts, index DB. Skip caches and
bakes — both are reproducible from the rest.

## 5. Sidecar schema

One JSON file per logical image. The "image" the post references is
`(original_id, ops_list)`. The author can edit `ops` after upload; each
save mutates the sidecar but never the original.

```json
{
  "version": 1,
  "original": "abcd1234ef56...",          // sha256 hex of master bytes
  "source": {
    "kind": "gdrive",                     // upload | url | dropbox | onedrive | gdrive
    "fileId": "1XyZ...",                  // provider-specific
    "fetched": "2026-05-06T14:22:11Z",
    "originalName": "DSC_0142.NEF.jpg"
  },
  "metadata": {
    "width": 6000, "height": 4000,
    "format": "jpeg",
    "exif": { "DateTimeOriginal": "...", "Model": "..." }
  },
  "ops":       [ /* author's click order */ ],
  "redoStack": [ /* ops popped via undo */ ],
  "outputs":   [ { "format": "webp", "quality": 85 },
                 { "format": "avif", "quality": 70 } ],
  "variants":  [ { "w": 400 }, { "w": 800 }, { "w": 1600 } ]
}
```

### Op types

| type | shape | meaning |
|---|---|---|
| `crop` | `{x, y, w, h}` | extract a region in current-canvas coords |
| `rotate` | `{degrees}` | multiple of 90° |
| `flip` | `{axis: 'horizontal' \| 'vertical'}` | mirror along an axis |
| `resample` | `{w?, h?, fit}` | downscale only — never enlarges |
| `perspective` | `{corners: [[x,y]×4]}` | rectify a tilted quadrilateral; tl/tr/br/bl in current-canvas coords |

### Op semantics

- `ops` is the author's click order. Coords on each op are interpreted
  in the canvas state at the time it runs (post-prior-ops). A `crop`
  recorded after a `rotate` therefore stores coords in the rotated
  canvas's coordinate space.
- `redoStack` is parallel: ops popped via undo, in pop order (last
  entry redoes first). Persisted with the sidecar so undo/redo survives
  reload. Adding a new op clears the redo stack — the standard
  linear-undo invariant.
- The executor simplifies adjacent logical no-ops at execution time:
  `rotate(a) + rotate(b)` combine into `rotate(a+b mod 360)` (drop if
  zero); same-axis flip pairs cancel. Storage stays in click order so
  the edits panel still reflects what the author actually did.
- `outputs × variants` enumerates the derivative set (per-format,
  per-width).
- A derivative's cache key is `hash(original_id, canonical-json(ops),
  variant, format, quality)`. Canonical-json sorts keys recursively,
  no whitespace, no trailing zeros, ASCII-only escaping, so
  semantically-identical ops produce identical hashes.

## 6. Image-edit model

The author opens an image in the editor, applies ops (rotate / flip /
crop / resample / perspective / undo / redo / delete-step / reset),
and clicks **Save edits**.

- Each op click updates an in-browser local edit state for the active
  image; nothing crosses the wire per click. Live preview rebuilds in
  the browser, fast-path optimized so adding one op only runs that one
  op against the cached previous result.
- The Save edits button is disabled until the local state differs from
  the last server-known state (a "dirty" check).
- Save commits ops + redoStack to the sidecar and uploads the
  browser-baked post-ops image as a WebP. The bake is the
  authoritative pixel result for that op chain; the public renderer
  reads it as the source for variant downscale + format encode.
- `Reset edits` clears the local op chain (the master is untouched).
- Switching to another image preserves in-progress edits across the
  session. Reload silently discards them; reload while any image is
  dirty surfaces a browser warning.
- Saving the post auto-commits any dirty image edits first; on
  failure the post save is aborted so partial state isn't published.

### Cropper

Sources from the local post-ops canvas, not the server preview, so
crop coords land in current-canvas space and crop appends to the op
chain instead of replacing it. Prior rotates / flips / crops survive a
new crop.

### Perspective rectify

A 4-corner drag modal with handles initially at the four image
corners. The author drags them to the corners of the region to
straighten. Save commits a `perspective` op whose corners are in
current-canvas pixel space. The output rectangle is sized from the
average of opposing edge lengths so a tilted square stays square.
Degenerate quads (three colinear corners) are refused with a status
message; perspective rectify requires the browser to support a
hardware-accelerated 2D pixel transform (the button is disabled
otherwise).

## 7. Derivative rendering

```
GET /img/<originalId>.<ophash>.<format>
```

Front proxy serves the file directly when present. On miss the
application server:

1. Verifies the URL's `<originalId>` resolves to a sidecar and the
   `<ophash>` matches one of the declared `outputs × variants`
   combinations under the current ops.
2. Sources the pixels — bake when present, master + apply ops
   otherwise. Sources are tried in this order:
   - cache file at the URL (already-rendered derivative)
   - `bakes/<id>` (already-applied ops, just downscale + encode)
   - `originals/<id>` (apply ops, downscale, encode)
3. Writes atomically to the cache path; from there the front proxy
   serves it for every subsequent request.

A configurable wall-clock budget governs synchronous rendering. Past
budget the request returns `202 + a placeholder` and a job worker
finishes the render in the background; subsequent requests pick up
the cached result. The exact default is set by the implementation
(see `implementation.md` §5).

### Bake invalidation

- Mutating a sidecar's ops unlinks the bake (ops changed → bake
  stale) and any prior cache entries for that id.
- Uploading a new bake unlinks any prior cache entries for the same id
  so re-bakes don't serve stale derivatives.
- A render request landing between "bake unlinked" and "new bake
  uploaded" falls through to the master + apply-ops path. One slower
  request at most; correct content.

## 8. Content model

### Post storage

Posts are markdown files with YAML frontmatter:

```markdown
---
title: Post title
slug: post-title
date: 2026-05-06T14:00:00Z
status: published
---

Prose paragraph.

::image{id=abcd1234ef56 alt="Caption text"}

More prose.

::gallery{ids=[abcd…, ef01…, 2345…] layout=masonry}
```

Custom widgets use the [CommonMark generic directive](https://talk.commonmark.org/t/generic-directives-plugins-syntax/444)
syntax (`::name{attrs}`).

### Editor

Custom node types per widget — the author sees image / gallery /
carousel / diptych / triptych blocks, never the directive syntax.
Round-trips through markdown on save and reload. The ProseMirror ⇄
markdown conversion happens in the browser; `POST /admin/posts`
accepts markdown directly so the same endpoint can be driven by other
tools (e.g. the WordPress importer).

## 9. Image widgets

The post body uses a single `::figure` directive for all image display.
One directive collapses what used to be five (`::image`, `::diptych`,
`::triptych`, `::gallery`, `::carousel`); layout is described by
attributes rather than by directive name. See "Migration plan" below
for the transition strategy from the legacy directives.

### Syntax

```
::figure{ids="<id>[,<id>…]" [matrix=NxM|justified[:H]|masonry[:N]]
         [justify=J] [width=…] [aspect=W:H] [fit=cover|contain]
         [alts="…,…"] [captions="…|…"] [caption="…"] [timer=N]}
```

`ids` is the only required attribute; all others have defaults.

### Attributes

| attribute | required | default | purpose |
|---|---|---|---|
| `ids` | **yes** | — | comma-separated sha256 hex (6+ char prefix or full 64) |
| `matrix` | no | `1x1` | display layout; see Matrix table |
| `justify` | no | `center` | block placement; see Justify table |
| `width` | no | (justify default) | block width with explicit unit: `400px` or `60%` |
| `aspect` | no | (first image's native aspect) | per-cell display aspect ratio, e.g. `16:9` |
| `fit` | no | `cover` | how the image fills its cell: `cover` (fill, crop edges) or `contain` (letterbox) |
| `alts` | no | — | comma-separated alt text, parallel to `ids` |
| `captions` | no | — | pipe-separated per-image captions (pipe avoids comma collisions in alts) |
| `caption` | no | — | one caption for the whole `<figure>` |
| `timer` | no | — | autoplay seconds when carousel mode kicks in (cap 60) |

Attributes that don't apply to the chosen `matrix` mode (e.g. `aspect`
+ `fit` under `justified` / `masonry`; `width` under `full` / `bleed`)
are silently ignored — the directive is forgiving so authoring stays
quick.

### Matrix

| value | meaning |
|---|---|
| `NxM` | uniform grid: N rows × M cols, every cell at the same `aspect`. Default: `1x1`. |
| `justified` | Flickr-style: rows of varying-width images at uniform row height. `:HHH` overrides row height (default ~240px). |
| `masonry` | Pinterest-style: columns of varying-height images at uniform column width. `:N` overrides column count (default 3). |

`aspect` and `fit` apply only to `NxM`. In flow modes (`justified`,
`masonry`) each image renders at its native aspect — that's the whole
point of the flow.

### Justify

| value | layout |
|---|---|
| `center` | block centered in the prose column; `width` defaults to 100% of column |
| `left` | float left; prose wraps right; `width` defaults to 40% on desktop, 100% on mobile |
| `right` | mirror of `left` |
| `full` | spans the wider content-column width (breaks out of prose column); ignores `width` |
| `bleed` | spans the full viewport width (breaks out of content column too); ignores `width` |
| `inline` | image flows inline with surrounding text at ~1.5em; `matrix`, `aspect`, `fit`, `width`, `caption` all ignored. Use only with a single `id` (extra ids are ignored). |

### Sizing semantics

The image's native aspect ratio is always preserved. `aspect` controls
the *cell* aspect ratio in `NxM` mode: the renderer reserves a box at
`aspect` per matrix cell and fits the image inside per `fit`.

- `fit=cover`: image fills the cell; if aspects differ, edges are
  cropped (typical photo-blog behavior).
- `fit=contain`: image fits inside the cell; if aspects differ, the
  cell shows letterbox bars (technical / art images).

When `aspect` is omitted, the cell aspect defaults to the first
image's native aspect (read from its sidecar at render time).

The whole figure's display aspect is `aspect × cols : rows` — used to
reserve layout space and avoid CLS as images load.

### Carousel mode (overflow)

When `len(ids) > matrix.rows * matrix.cols` in `NxM` mode, the figure
becomes a horizontal-scrolling carousel: **rows stay fixed**, columns
expand to hold every image. The visible window is `matrix.cols` wide;
scroll/swipe/click advances by that many columns.

For example, `matrix=2x3` with 8 ids renders 2 rows × 4 cols (the
last column is half-full); the viewport shows 3 cols at a time. Same
attributes accepted in the visible-grid case (`aspect`, `fit`, etc.)
apply per cell.

`timer=N` autoplays the scroll at N seconds per page (cap 60). When
omitted, advance is manual only (prev/next, swipe, keyboard). Same
accessibility constraints as today's `::carousel`: pauses on
hover/focus/page-hidden, reduced-motion respected, accessible
play/pause when `timer` is set.

`justified` / `masonry` modes don't carousel — they grow vertically
to fit every image.

### Edge cases

- `matrix` omitted with N images → default `1x1`. With `N>1` ids, the
  excess overflows into carousel mode (so a single id list with no
  matrix attribute renders sensibly even without a matrix override).
- Over-allocated matrix (`matrix=2x3` with only 2 ids) → render the
  excess cells empty; the author asked for that layout. No
  auto-shrink — keeps the rendered result predictable.
- `matrix=1x1` with N>1 ids → carousel with one cell visible at a
  time; rows stay fixed at 1 → the carousel is a horizontal strip.
- `ids` empty or all unresolvable → the figure is replaced by an HTML
  comment so authoring errors are visible without breaking the page.
- Inline mode with multiple ids → second-and-later ids ignored; only
  the first renders inline.

### Render output

A single `<figure class="rkr-figure rkr-justify-{justify}
rkr-fit-{fit}">` containing either:
- a CSS-grid `<div>` (matrix mode, no JS), or
- a CSS-grid scroll-snap track + small JS controller (carousel mode).

Each cell wraps a `<picture>` with one `<source>` per format and
srcset entries from the widget's declared variants, plus a JPEG
fallback (kept aligned with `DEFAULT_VARIANTS × DEFAULT_OUTPUTS` at
ingest — see test/lib/widget-fallback-alignment.test.ts).

`<figcaption>` appears only when `caption` is set. Per-image
`captions[i]` go inside that cell's `<picture>` wrapper.

### Lightbox

Unchanged: clicking any cell overlays it fullscreen; ESC or
click-outside dismisses. The block `caption` (if any) — or the per-
image `captions[i]` — appears as the lightbox caption.

### Migration plan

The legacy directives (`::image`, `::diptych`, `::triptych`,
`::gallery`, `::carousel`) ship in posts on disk today. Transition:

1. **Spec freeze** (this document) defines the target syntax. ✅
2. **Implement `::figure`** as a new widget alongside the legacy ones. ✅
3. **Migrate the WP importer** to emit `::figure` for all imported
   posts. Existing imported posts on disk keep working via legacy
   widgets. ✅
4. **Editor (TipTap) round-trip plumbing**: figure node with full
   attribute set + markdown ⇄ figure conversion in prose-markdown. ✅
5. **One-shot migration tool** (`site-admin migrate-figures`) was
   shipped to rewrite legacy directives in `content/posts/*.md`. After
   the editor unification + reseed, no legacy directives remain in any
   live post; the tool was deleted as dead code. ✅
6. **Server-side legacy widget deletion**: drop
   `src/widgets/{image,diptych,gallery,carousel}.ts`, their tests,
   their CSS, and the WidgetRegistry registrations. The figure widget
   becomes the only image directive the public renderer recognises.
   Constants-alignment test shrinks to one widget × one fallback. ✅
7. **Editor unification**: legacy ProseMirror node types
   (ImageNode/GalleryNode/CarouselNode/DiptychNode/TriptychNode) are
   removed. The editor uses a single `figure` node; the toolbar /
   attribute-panel UI discriminates between image / gallery / carousel
   / diptych / triptych modes by inspecting the figure's `matrix` +
   `ids` count via the `figureKind` adapter (src/admin/main.ts). All
   prose-markdown emit / parse goes through one path. ✅

The unification is fully complete: every directive on disk is
`::figure`, the public renderer has only one image widget, and the
editor save/load flow round-trips through `::figure` markdown while
preserving the existing per-node-type editing affordances.

## 10. Remote image import

| Provider | Mechanism | Auth |
|---|---|---|
| Local upload | multi-file input + drag-drop / paste into the editor | session |
| Plain URL | server-side fetch (size + content-type capped) | session |
| Dropbox | Chooser SDK | none for read |
| OneDrive | File Picker SDK + Graph API | OAuth2 |
| Google Drive | Picker API + Drive v3 (`drive.file` scope) | OAuth2 |

Common path: picker returns a file handle → server streams bytes →
sha256 during stream → if hash already in originals, dedupe; otherwise
atomic-rename into place → write sidecar with `source.kind` set.
Provenance is recorded but the original is treated identically
regardless of source.

OAuth tokens are stored encrypted at rest with a server-held key.

## 11. HTTP routes

```
GET  /                              rendered post index
GET  /:slug                         rendered single post
GET  /img/:filename                 derivative image (cache-miss handler)
POST /admin/login                   OAuth start (provider redirect)
GET  /admin                         editor SPA
POST /admin/posts                   create post
PUT  /admin/posts/:id               update post
POST /admin/upload                  multipart, streams to originals
POST /admin/import/url              server-side fetch
POST /admin/import/dropbox          accept Chooser payload
POST /admin/import/onedrive         accept Picker payload + token
POST /admin/import/gdrive           accept Picker payload + token
GET  /admin/preview/:id             302 to a derivative URL the editor uses as <img src>
GET  /admin/original/:id            stream the master bytes for the client canvas pipeline
GET  /admin/sidecar/:id/meta        sidecar dimensions + ops + redoStack
POST /admin/sidecar/:id/ops         replace ops + (optional) redoStack
POST /admin/sidecar/:id/bake        upload the client-baked post-ops image
GET  /health                        liveness probe
```

## 12. Operator commands

A single CLI binary exposes everything an operator can do outside the
editor:

```
init                    create the runtime data tree, run migrations
migrate                 run pending migrations
reindex                 rebuild post index from content/
render                  pre-render every variant for every sidecar
render --post <slug>    pre-render one post
render --since <date>   pre-render posts newer than date
render --force          re-render even existing cache entries
gc                      delete cache entries that no sidecar references
verify                  rehash originals; flag mismatches
import-wp list <base-url>          list posts on a WordPress source
import-wp post <base-url> <id>     import one WP post + every image it references
import-wp push <base-url> <slug> --to <fly-url>  push one post to a remote rkroll-cms via /admin
user invite <email>     add to the allowlist (owner / editor role)
user list / remove
server [--port N]       run the application server
```

`render` warms the cache (e.g. after a bulk ops change). `gc` walks
every sidecar, builds the set of valid `<id>.<ophash>.<fmt>` filenames,
deletes everything in the cache not in the set; idempotent.

## 13. Auth

- **Social login only.** Sign in via Google (Apple deferred). No
  passwords stored anywhere.
- **Invite-only allowlist.** A successful Google authorization only
  creates a user if the email is on the allowlist. Roles: `owner`
  (everything) and `editor` (everything except user management).
- **Sessions:** server-side, 30-day expiry, sliding last-seen.
  Cookie is `HttpOnly`, `Secure`, `SameSite=Lax`.
- **Per-user picker tokens** (Drive, OneDrive) live encrypted in the
  index DB.
- **CSRF**: Origin/Referer guard for state-changing methods, plus
  `SameSite=Lax` session cookie as the primary line. The cookie alone
  blocks the realistic threat model (top-level GET navigation,
  cross-site form POST); the Origin check is defense-in-depth in case
  a future browser-quirk or extension bypasses SameSite.
- **Bearer-token bypass for scripted clients.** When the env var
  `ADMIN_TOKEN` is set, requests carrying `Authorization: Bearer
  <ADMIN_TOKEN>` skip the cookie path and attach a synthetic admin
  user (constant-time match). CSRF guard is also skipped on these
  requests since browsers don't auto-send `Authorization` headers; the
  token itself is the CSRF defense. Used by the WordPress importer's
  push mode and any future scripted admin tooling. Leave `ADMIN_TOKEN`
  unset to disable the bridge entirely.

## 14. Deployment configuration

Per-deployment environment surface:

| variable | default | purpose |
|---|---|---|
| `SITE_ROOT` | `/var/www/site` | root of the runtime data tree |
| `PORT` | `3000` | application server listen port |
| `HOST` | `127.0.0.1` | listen interface (front proxy reverse-proxies) |
| `SITE_TITLE` | `rkroll` | header title + `<title>` suffix |
| `SITE_TAGLINE` | (none) | optional subtitle |
| `PUBLIC_BASE_URL` | (required) | used to build OAuth redirect URI |
| `GOOGLE_CLIENT_ID` | (required) | Google OAuth |
| `GOOGLE_CLIENT_SECRET` | (required) | Google OAuth |
| `ADMIN_TOKEN` | (unset) | when set, enables `Authorization: Bearer` admin auth for scripted clients (WP importer push mode); leave unset to disable |
| `LOG_LEVEL` | `info` | server log threshold |

The session-signing and token-encryption secret lives in
`$SITE_ROOT/data/secret.key` (mode 0600), generated by `init` if
absent.

## 15. Out of scope (v1)

Adding any of these requires reopening the spec.

- Plugin / theme marketplace.
- Multi-tenant operation.
- Real-time collaboration.
- A WYSIWYG editor that matches the published theme exactly.
- Cloud storage for originals or cache.
- A CDN in front of the front proxy.
- WebSockets / SSE / any real-time channel.
- ImageMagick (only one image library is in scope at a time).
