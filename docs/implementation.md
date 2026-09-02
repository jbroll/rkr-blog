# rkr-blog — Implementation

How this codebase delivers [spec.md](./spec.md). Stack choices, repo
layout, database schema, image pipeline internals, deployment shape.

For developer setup (lint, test, hooks, dev commands), see
[developer-quickstart.md](./developer-quickstart.md).

---

## 1. Stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node 22 LTS or later | `node:sqlite` available; native fetch; native test runner; `--experimental-strip-types` runs TypeScript directly. |
| HTTP server | Fastify 5 | Async-native, low per-request overhead, plugin-based composition. |
| HTTP plugins | `@fastify/multipart`, `@fastify/cookie`, `@fastify/static`, `@fastify/rate-limit` | Official, narrow-scoped; no extra abstractions. |
| Database | `node:sqlite` (built-in, WAL) behind a thin wrapper | Zero native deps; single-writer model fits a single-author CMS. The wrapper normalizes node:sqlite's null-prototype rows, supplies `transaction()`, and coerces bigint rowids — not for swap-out parity. |
| Image pipeline (server) | Sharp (libvips) | Releases the libuv thread pool; AVIF/WebP/EXIF/ICC handling. |
| Image pipeline (client) | HTMLCanvasElement + WebGL (perspective only) | No external library; 4-corner perspective uses a tiny fragment shader. |
| Markdown | `remark` + `remark-directive` + `remark-frontmatter` | Stable AST; the directive syntax fits widget blocks. |
| Editor | TipTap (ProseMirror) | Custom node types map cleanly to widget blocks; markdown round-trip via the `remark` plugin family runs in the browser, so `POST /admin/posts` is a markdown-only endpoint. |
| Editor bundle | esbuild | TipTap bundled into a single browser file so the admin SPA has zero CDN dependencies and a tight CSP. |
| Auth | OAuth (Google) via `arctic` | No password to store; provider handles MFA / recovery. |
| Front proxy | Apache 2.4 (`mod_rewrite` + `mod_proxy_http` + `mod_headers` + `mod_expires`) | Static cache hits never reach Node. |

### Out-of-scope choices

These are deliberately excluded from v1. Reopening the spec is required
to add any of them.

- **Bundlers for the runtime** (Webpack, Vite, runtime esbuild). Source
  runs as-is via Node's TypeScript loader; no `dist/` directory.
  esbuild is used only for the *admin* browser bundle.
- **Express, Koa, Hapi.** Fastify only.
- **Redis, BullMQ.** The jobs table in SQLite is the queue.
- **Any ORM** (Prisma, Drizzle, Sequelize, Knex). Hand-written SQL
  through the `lib/db.ts` wrapper.
- **React / Vue / Svelte** for public pages. Public output is
  server-rendered HTML.
- **Docker / Kubernetes / containerization.** Direct install on the
  VPS.
- **Cloud storage** (S3, R2). Originals and cache live on local disk.
- **A CDN.** Apache serves cache directly.
- **WebSockets / SSE.**
- **ImageMagick.** Sharp / libvips only.
- **`sqlite3` or `better-sqlite3`.** Use `node:sqlite` behind the wrapper.

## 2. Repo layout

| Directory | Purpose |
|---|---|
| `bin/` | CLI entry point (`site-admin`) and server entry point |
| `src/lib/` | Framework-agnostic library code: DB wrapper, image pipeline, posts, auth, sessions, config |
| `src/widgets/` | Public renderer widgets — `::figure` and `::video` |
| `src/admin/` | Editor browser bundle (esbuild → `static/admin/`): 48 files covering editing, image ops, offline sync, and settings |
| `src/site/` | Public-page browser scripts (esbuild → `static/site/`): lightbox, carousel, comment form, service worker |
| `src/templates/` | Server-side HTML templates (TypeScript template literals) |
| `src/routes/` | Fastify route modules (one per concern) |
| `src/cli/` | One file per `site-admin` subcommand |
| `packages/image-edit/` | Workspace package, built and tested on its own: `src/core/` is the pure op model (validation, canvas math, rotation) shared by server and browser; `src/canvas/` is the browser-only DOM/WebGL layer (crop + perspective modals, encode). Two exports, `.` and `./canvas` |
| `apps/image-pwa/` | Workspace package: the standalone image editor, a fully client-side PWA over `@rkr/image-edit`. Ships only where a site sets `DEPLOY_IMAGE_EDITOR=yes` (see `RUNBOOK.md`) |
| `test/` | Unit + integration tests mirroring `src/` layout; e2e specs under `test/e2e/` |
| `src/migrations/` | Numbered SQL migration files applied by `site-admin migrate` |
| `deploy/` | Per-site deploy config (`common.conf`, `sites/*.conf`) and the `deploy.sh` hooks that generate the Apache vhost and patch the systemd unit |
| `ci/` | The two jobs the pre-commit gate dispatches to the CI host (`test`, `e2e`) and `simple-ci.conf`, the host list. See `developer-quickstart.md §6` |
| `website/` | The static marketing site at `rkr-blog-www.rkroll.com`, deployed on its own. Documented in `website/README.md` |

The runtime data tree (`originals/`, `sidecars/`, `bakes/`, `cache/`,
`content/`, `data/`) lives **outside** the repo, configured via
`SITE_ROOT` (default `/var/www/site`). The repo is portable; the data
is not.

## 3. Runtime data layout (deployed paths)

```
$SITE_ROOT/
  originals/
    ab/cd/abcd1234ef….jpg              # 2/2 prefix sharding by id
    videos/
      ab/cd/abcd1234ef….mp4            # video masters (same sharding)
  sidecars/
    abcd1234ef….json
    videos/
      abcd1234ef….json                 # video sidecar (trim/poster state)
  bakes/
    ab/cd/abcd1234ef….webp             # always WebP at q=0.95
  cache/
    img/                               # served directly by Apache
      abcd1234ef….<ophash>.webp
      abcd1234ef….<ophash>.avif
    video/                             # served directly by Apache
      abcd1234ef….<ophash>.mp4
      abcd1234ef….<ophash>.jpg         # poster
  content/
    posts/
      2026-05-06-slug.md
  data/
    site.db                            # SQLite WAL
    secret.key                         # mode 0600; AES key for token encryption
  static/                              # CSS, compiled JS bundles, fonts
```

## 4. Database

`src/lib/db.ts` is a thin wrapper around `node:sqlite` that normalises null-prototype rows, provides `transaction()`, and coerces bigint rowids. It is not designed for swap-out parity — the wrapper exists to keep call sites clean.

`node:sqlite` requires `--experimental-sqlite` on Node 22 (unflagged on Node 24+). The server and CLI suppress the startup notice with `--no-warnings=ExperimentalWarning`.

### Tables

| Table | Purpose |
|---|---|
| `schema_migrations` | Tracks applied migration versions |
| `posts` | Index over `content/posts/*.md` — rebuilt by `site-admin reindex`; not the source of truth |
| `jobs` | Render job queue with atomic state transitions; deduped by cache key |
| `users` | Author accounts with `owner` / `editor` roles |
| `oauth_accounts` | OAuth provider + subject ID linked to a user |
| `allowed_emails` | Invite allowlist; a Google login only creates a user if the email is present here |
| `sessions` | Server-side sessions (30-day fixed expiry; `last_seen_at` updated on each request) |
| `oauth_tokens` | Encrypted Drive / OneDrive picker tokens per user |
| `comments` | Reader comments with `pending` / `published` / `rejected` / `queued` status |
| `tags` | Normalised tag names (`COLLATE NOCASE`); first writer wins on casing |
| `post_tags` | Many-to-many join between `posts` and `tags`; cascades on post delete |
| `posts_fts` | FTS5 virtual table (`porter unicode61`) over title, tags, and body; populated by `reindex` in the same pass that upserts `posts`; joined back to `posts` on slug for status/date scoping |

See `src/migrations/` for the full schema. `site-admin migrate` applies any unapplied file numerically, each in its own transaction. No down-migrations in v1; rollback by restore from backup.

### Roles

`requireUser` (any authenticated user) and `requireOwner` (`role === 'owner'` only) are the two `/admin/*` route guards. `src/routes/admin.ts` builds them as `guard` and `ownerGuard` and threads them into each route registrar, but only when `opts.requireAuth` is set — with it false both are `{}` and the routes are open, which is how tests reach them.

The two integration modules are the exception. `src/routes/integrations-gdrive.ts` and `integrations-onedrive.ts` are registered from `src/server.ts`, not from `admin.ts`, and build their own `guard`/`ownerGuard` unconditionally. Their 9 owner routes stay owner-gated whatever `requireAuth` says.

Owner covers stored credentials, site config, and everything-at-once operations:

| Route | Why owner |
|---|---|
| `/admin/integrations/{gdrive,onedrive}/connect`, `/callback`, `/disconnect` | OAuth flow. The callback too — it stores tokens against the caller, so it must not be reachable by someone who cannot start the flow |
| `/admin/integrations/gdrive/access-token`, `/admin/integrations/onedrive/{access-token,picker-token}` | Hands out a live provider token |
| `GET`/`POST /admin/settings`, `/admin/settings/site`, `/admin/settings/banner`, `/admin/settings/{gdrive,onedrive}/disconnect` | Site-wide config and the same stored credentials |
| `GET /admin/export`, `POST /admin/import` | The whole site's content in one request |
| `POST /admin/reset` | Wipes posts, originals, sidecars, and cache |

Everything else — post CRUD, uploads, comments, the editor shell — stays on `requireUser`, since an editor who cannot write content isn't an editor. `POST /admin/reindex` (`admin-settings.ts`) and `POST /admin/posts/:slug/delete` (`admin-posts.ts`) are deliberate `requireUser` routes despite living next to owner ones: both rebuild or remove content an editor is already allowed to write, and neither touches a credential or the site as a whole.

When adding a route, default to `requireUser`. Reach for `requireOwner` only when it touches a stored credential, global config, or the whole site's data rather than a single post.

## 5. Image pipeline internals

### Server: `lib/render.ts → renderDerivative`

```ts
async function renderDerivative({
  originalId, ops, variant, output, siteRoot
}): Promise<{ path, bytes, cached }>
```

Behavior:

1. Compute `ophash` from `(originalId, ops, variant, output)` via
   canonical JSON + sha256, truncated to 12 hex chars.
2. Output path: `${siteRoot}/cache/img/${originalId}.${ophash}.${format}`.
3. **Fast path**: if the file exists, return `{ cached: true }`
   without invoking sharp.
4. **Source precedence on cache miss**:
   - `bakes/<id>.webp` if present → use as source AND skip
     `applyOp` (the bake is post-ops; the client baked it via the
     canvas pipeline). Sharp's job is variant downscale + format
     encode only.
   - `originals/<id>.<ext>` otherwise → fall back to applying the
     full ops chain in sharp. Sharp has no homography operator, so a
     `perspective` op materialises the pipeline so far as a raw RGBA
     buffer (`ensureAlpha()` first — `resamplePerspective` hardcodes a
     4-channel stride), runs the pure-JS `resamplePerspective`, and
     restarts sharp from the result. Only a malformed quad or singular
     homography throws.
5. Write to a temp file; atomic rename into place.
6. Concurrency: `sharp.concurrency(1)` per call so libvips threads
   don't multiply with job concurrency.

### Client: `packages/image-edit/src/{core,canvas}/`

`core/canvas-math.ts` is DOM-free so the server-side test runner can
import it. Holds:

- `computeResampleSize` — sharp-compatible inside-fit math.
- `simplifyOps` — collapses adjacent rotates and same-axis flip pairs
  (storage stays in click order; only the executor simplifies).
- `computeHomography` — 8×8 Gauss-Jordan with partial pivoting;
  returns `null` for singular systems (three colinear points).
- `invertMatrix3` — cofactor inverse; returns `null` when singular.
- `perspectiveOutputSize` — averages opposing edge lengths so a
  tilted square produces a square output.
- `opsEqual` — sorted-key JSON canonicalization for cache-prefix
  comparison.

`core/rotation.ts` holds `inscribedRect(W, H, angleDeg)`: the largest
axis-aligned rectangle, centred on the image centre, inside a W×H
image rotated by that angle, plus its `left`/`top` offset within the
rotated bounding box `(W·cosθ + H·sinθ) × (W·sinθ + H·cosθ)`. The
angle is folded into `[0°, 90°]` first, since the geometry repeats
across quadrants. Two regimes: with all four sides binding,
`rw = (W·c − H·s)/cos 2θ`, `rh = (H·c − W·s)/cos 2θ`; when only the
shorter pair binds, `rw = H/(2s)`, `rh = H/(2c)` for landscape (W and H
swapped for portrait). The fully-constrained branch is skipped when
`|cos 2θ| ≤ 1e-6` (division blows up near 45°), and where both
regimes apply the larger area wins, because the first formula is not
the maximum across the whole mid-angle range. Results are floored so
sharp's `extract` gets integers. It is the one copy of the formula:
validation, the canvas pipeline and the sharp pipeline all import it,
which is what keeps client and server dimensions in agreement.

`canvas/canvas.ts` is the DOM-touching half:

- `applyOps(source, ops): HTMLCanvasElement` — runs the simplified
  chain via Canvas2D ops (crop / rotate / flip / resample) and
  WebGL (`applyPerspective`).
- `PipelineCache` — per-image, holds the last simplified op list
  and result canvas. On the common "added one op" case applies just
  that op to the cached canvas (the "only execute the last step on
  each change" fast path). Insert / delete / undo / redo miss the
  cache and re-execute from source.
- `applyPerspective` — compiles a tiny WebGL program once per call.
  Vertex shader flips Y so `v_dst` is canvas-Y-down throughout
  (no `UNPACK_FLIP_Y_WEBGL`, no fragment-side flip). Fragment shader
  samples the source via the inverse homography per pixel.
  Out-of-source samples are transparent. The result is copied back
  to a 2D canvas so downstream ops in the chain stay
  HTMLCanvasElement-based. WebGL unavailability falls through to
  pass-through (the perspective button is disabled in the editor's
  UI when WebGL is unavailable).

### Arbitrary-angle rotation

`rotate` takes any finite angle; `validateOps` normalises it to
`[0, 360)`, drops `0`, and tracks running dimensions so a later `crop`
is bounds-checked against what the rotate leaves: a swap for 90°/270°,
unchanged for 180°, `inscribedRect` otherwise. The op schema did not
change; only the multiple-of-90 check went.

- **Client (`applyRotate`).** 90°/180°/270° keep the whole-canvas
  path. Any other angle draws into a canvas already sized `iw × ih`,
  translated to its centre and rotated, with
  `imageSmoothingQuality = 'high'` (bicubic); no separate crop step,
  the canvas bounds are the crop.
- **Server (`applyOp`).** The orthogonal angles go to `sharp.rotate`,
  which libvips handles without resampling. Otherwise
  `rotate(deg, {background: transparent})` expands to the bounding box
  and `extract` cuts the inscribed rect. `applyOp` needs the current
  dimensions for that, so `renderDerivative` threads `{w, h}` through
  the ops loop via `nextDims`, mirroring the validator's rule.
- **Which pixels get published.** The bake wins whenever one exists,
  so a published tilt is the canvas's bicubic result. The sharp path
  (Lanczos from the original) runs only when there is no bake, such as
  a sidecar written by a scripted client.

`appendRotate` merges a new angle into a directly preceding `rotate`,
so the tilt control never grows the op list; `describeOp` shows angles
over 180° as negative.

### Editor state machine: `src/admin/main.ts`

- `LocalEditState` per image id: `{ ops, redoStack, baseline,
  sourceWidth, sourceHeight }`. `baseline` is the last-saved-from-server
  snapshot used for the dirty check.
- All op clicks mutate `LocalEditState` synchronously. No server I/O
  per click. Live preview rebuilds via `PipelineCache.apply`.
- `saveImageEdits(id, s)` — POSTs a single multipart `commit` with
  ops + redoStack and (when ops is non-empty) the WebP bake in one
  atomic request; updates `baseline` only after the call lands.
- `flushDirtyImageEdits()` — saves every dirty image in parallel
  via `Promise.allSettled`; called by both the per-image **Save
  edits** button and the post-Save flow (so saving the post auto-
  commits any dirty image edits first; partial-failure aborts the
  post save).
- `beforeunload` listener blocks reload while any image is dirty.
- Per-image caches (`originalCache`, `pipelineCaches`,
  `previewBlobUrls`) live in `src/admin/canvas-loaders.ts` and are
  bounded by a 16-entry LRU. Eviction revokes Blob URLs so the
  underlying Blobs are freed. `localEditState` is intentionally
  uncapped — entries are tiny JSON and evicting a dirty entry would
  silently lose unsaved work.

### Bake invalidation contract

`POST /admin/sidecar/:id/commit` is the single atomic image-edit save
endpoint (replaced the prior two-step `/ops` + `/bake` split). It accepts
a multipart payload with two parts:

- `ops` (text field) — JSON containing the new `ops` and `redoStack`.
- `bake` (file part) — the client-rendered WebP. Required when `ops`
  is non-empty; forbidden when `ops` is empty (the "clear all edits" case).

Invalidation sequence within the handler:

1. Snapshot `cache/img/<id>.*` filenames **before any write** to avoid
   racing a render-in-flight that's about to rename its tmp into place.
2. Write (or unlink) the bake file atomically via tmp + rename.
3. Write the updated sidecar.
4. Unlink the snapshotted stale cache files.

The previous `/ops` + `/bake` split left a window between two separate
HTTP requests where ops and bake could disagree; the `/commit` endpoint
reduces that window to adjacent filesystem operations in a single request.
A render landing in that window falls through to the original + applyOp
path: one slower request at most, always correct content.

### Save baselines

Both write paths take an optimistic-concurrency baseline so a queued
offline save can't silently revert newer work. `src/routes/post-base.ts`
(`X-Rkr-Last-Synced-At`, used by `POST /admin/posts`) and
`src/routes/sidecar-base.ts` (`X-Rkr-Sidecar-Base`, used by
`/admin/sidecar/:id/commit` and `GET /admin/sidecar/:id/meta`) each
compare the client's echoed timestamp against the file's mtime and
reject a mismatch with 409. Both are Fastify-free so the read route and
the write handler share one implementation. `docs/spec-offline.md` has
the mechanism and the replay rules.

### Magic-byte validation

`POST /admin/sidecar/:id/commit` checks the bake body starts with
`RIFF????WEBP` and decodes it via sharp before writing. Body is capped at
25 MB (`BAKE_MAX_BYTES`); WebP at q=0.95 for a 50 MP source is ~5–10 MB so
real bakes are well under.

## 5a. Video pipeline internals

Video is an isolated parallel to the image pipeline — `::video` never
mixes into `figure.ts`/`ImageMap`/`lightbox`.

- **Ingest** (`src/lib/video.ts:ingestVideoStream`): hash-while-stream
  to a tmp file, `ffprobe` for dimensions/duration/codecs, cap checks
  against `resolveVideoCaps(siteRoot)` (`config/site.json#videoCaps`),
  dedupe by sha256 into `originals/videos/<aa>/<bb>/<id>.<ext>`, write
  `sidecars/videos/<id>.json` via `src/lib/video-sidecar.ts`.
- **Sidecar** (`video-sidecar.ts`): version 1, source probe metadata,
  `ops` (trim), `poster.timeMs`. Atomic write, mirrors `src/lib/sidecar.ts`.
- **ffmpeg wrapper** (`src/lib/video-ffmpeg.ts`): `buildFfmpegArgs`
  (h264/aac, yuv420p, `+faststart`, `-vf scale='min(1920,iw)':-2`),
  `buildPosterArgs` (`-vframes 1 -q:v 2`), `probeVideo` (10 s timeout),
  `runFfmpeg` (stderr capture, kill-on-timeout, ENOENT error).
- **Render** (`src/lib/video-render.ts:renderVideoDerivative`): cache key
  via `cacheKey({originalId, ops, variant, output})` — video
  `{w:1920,mp4}`, poster `{w:640,jpg,posterTimeMs}` (poster time is in
  the hash so a `poster=` edit invalidates the immutable URL). Atomic
  tmp+rename; inflight dedup + `Semaphore(1)`.
- **Serve** (`src/routes/public-video.ts`): regex-validates
  `<id>.<ophash>.mp4|jpg`, 404 on stale ophash, 422 under 16 px, render
  within `renderBudgetMs` → 202 + enqueue on timeout, Range/206 + 416
  via `fs.createReadStream(start,end)`, `Cache-Control: immutable`,
  600/min/IP.
- **Client retry** (`src/site/video-retry.ts`): clone of `img-retry.ts`
  for `<video>` — backoff `[500,1500,3000,6000,10000]`, `rkr_retry` param,
  abort on tab hidden, swap `src` on success.
- **Widget** (`src/widgets/video.ts` + `video-attrs.ts`): parses
  `ids/trim/poster/controls/autoplay/muted/loop/width/justify/caption`,
  looks the id up in `VideoMap` (`src/lib/video-map-fs.ts`, built from
  `sidecars/videos/*.json`), mints URLs via `urlFor`, emits
  `<figure class="rkr-video">` with `--rkr-video-aspect` reservation.
- **Admin** (`src/routes/admin-video.ts`): `POST /admin/upload/video`
  (ingest → eager transcode → URLs; 413 on cap, 422 on probe failure),
  `POST /admin/video/:id/trim` (validates, rewrites sidecar ops/poster,
  clears redoStack). TipTap `video` node (`src/admin/video-node.ts`)
  renders a preview + trim/poster/caption popover that persists to the
  sidecar via the trim endpoint. `::video` round-trip lives in
  `src/lib/prose-markdown-video.ts`.
- **OPFS preview map** (`src/admin/video-map-opfs.ts`): client-side copy
  of `video-map-fs.ts` computing the same ophashes from the OPFS
  `sidecars/videos` tree.

## 6. Job worker lifecycle

One worker codepath (`workQueue` in `src/lib/jobs.ts`) runs in two
contexts:

1. **Inside the Fastify server.** Started at boot, polls the jobs
   table on a 250ms tick when idle, woken immediately on new enqueue
   via in-process `EventEmitter`. Concurrency cap = `os.cpus().length`.
2. **Inside `site-admin render`.** Started when the command runs,
   exits when the queue is drained. Concurrency cap =
   `os.cpus().length - 1` so an interactive batch doesn't starve a
   live server on the same box.

Both compete for jobs via an atomic SQLite `UPDATE … WHERE state = 'queued' RETURNING id`. If the update returns no row another worker claimed it first; move on.

### HTTP miss handling

`GET /img/<filename>`:

1. Apache fall-through (the file isn't in `cache/`).
2. Fastify route parses `<originalId>.<ophash>.<fmt>` from the
   filename.
3. Looks up the matching sidecar + variant + output by ophash.
4. Calls `renderDerivative` synchronously with a wall-clock budget
   (`renderBudgetMs`, default 8 s).
5. On success within budget: `200` with the bytes (and Apache picks up
   subsequent requests from disk).
6. On budget exceeded: enqueues the job, returns `202` + a low-res
   placeholder, client retries.

The 8 s default keeps a miss inside a reader's patience on a low-end
VPS; the spec just calls for "configurable wall-clock budget" without
fixing the number. Override via `BuildAppOpts.renderBudgetMs` when
constructing the app (currently only used by tests).

## 7. Front proxy (Apache vhost)

`deploy/hooks/apache.build.post.sh` writes the vhost from the values in
`deploy/common.conf` and `deploy/sites/<site>.conf`. Key behaviours:

- `mod_rewrite` checks whether the requested `/img/*` path exists on disk; if so it rewrites directly to the `cache/img/` file, bypassing Node entirely. `/video/*.mp4` and `/video/poster/*.jpg` do the same against `cache/video/`.
- `/admin/static/*` is aliased to the same directory as `/static/*`. The
  admin service worker's scope is `/admin/`, so the shell's assets have
  to be reachable inside it; both prefixes serve identical bytes.
- Everything else proxies to `localhost:3000`.
- `cache/` and `static/` responses carry `Cache-Control: public, max-age=31536000, immutable`. The `immutable` flag is accurate because cache filenames are content-hashed.

Required modules: `rewrite`, `proxy`, `proxy_http`, `headers`, `expires`.

## 8. Editor browser bundle

`tsconfig.browser.json` names `src/admin/**`, `src/site/**`, and two
`src/lib` roots (`prose-markdown.ts`, `safe-url.ts`); the other lib
files the bundle uses are reached transitively. Anything `src/admin`
imports has to be free of node builtins — that is why the build
identity the shell and the drain routes share lives in
`src/lib/build-contract.ts`, apart from `client-build.ts`, which
resolves the server's own hash. The admin bundle is built with esbuild (TipTap +
ProseMirror + Cropper.js), ESM format with code-splitting:

- `static/admin/main.js` — editor SPA (TipTap, image ops, offline sync)
- `static/admin/posts-list.js` — post list page
- `static/admin/settings-page.js` — settings page
- `static/site/lightbox.js` — public-page lightbox
- `static/site/carousel.js` — public-page carousel runtime
- `static/site/comment-form.js`, `copy-link.js`, `img-retry.js`, `video-retry.js` — lightweight public-page helpers
- `static/site/sw-unregister.js` — loaded on all public pages; actively unregisters any prior SW at scope `/`
- `static/site/sw-admin.js` (thin event wiring; the cache logic lives in `src/site/sw-admin-core.ts`, unit-tested directly in Node) + `sw-admin-register.js` — admin PWA service worker and registration script
- `static/admin/precache.json` — the list of URLs `sw-admin.js` precaches, keyed by build hash; written by `scripts/gen-precache.ts` at the end of the top-level `build` script, not inside `build:admin` — it walks `static/site/` and `static/themes/` output, so `build:site` must already have run. Running `build:admin` alone leaves no `precache.json`. Each file is listed under the URL it is requested at: `static/admin/**` bare, because esbuild's chunks reach each other (and `preview-page`, `prose-markdown`) through relative imports, and relative resolution drops the `?v=` query; everything else with the `?v=<hash>` the templates stamp. `admin/main.js` and `admin/main.css` are stamped-only: the import direction is main → chunks, so nothing reaches them relatively and a bare entry would be a cache key nothing requests. The OPFS write worker is constructed from `/admin/static/admin/opfs-worker.js` for the same reason a stylesheet is: outside the worker's `/admin/` scope it is never intercepted, so it would not load offline.

The shell stamps the build it was rendered from into `<meta
name="rkr-build">`, and the bundle sends it back on every write that
carries queued offline work. An offline launch boots the cached shell,
so that meta is the stale bundle's build — which is what lets the
drain routes refuse it (`spec-offline.md §6`).

The editor converts ProseMirror → markdown locally before POSTing to
`/admin/posts`. The server only receives markdown (validated via
`parsePost`), so it never loads `prose-markdown.ts` at runtime. Note:
only `proseToMarkdown` is reachable from `src/admin/main.ts`, so the
remark/remark-directive/remark-frontmatter stack used by `markdownToProse`
is tree-shaken away — adding the import added ~3 KB to the bundle, not
the full ~70 KB the dependency tree would suggest.

All served at `/static/*` by `@fastify/static` in dev (Apache in
prod). The editor bundle has zero CDN runtime dependency; the only
third-party script-src is `apis.google.com` (the Google Drive picker
SDK, loaded dynamically by the gdrive integration).

## 8a. Figure image reorder

`src/admin/figure-reorder.ts`. A figure node carries three parallel
strings, `ids` (comma), `alts` (comma) and `captions` (pipe); a
reorder is one permutation applied to all three. `reorderFigureCells`
pads `alts` and `captions` to the `ids` length before moving, since
older posts have shorter arrays, and returns its input object on a
no-op (`from === to`, out of range, single image) so the caller can
skip the transaction on reference equality.

The figure is a plain node with no NodeView, so `wireFigureReorder`
installs delegated `pointerdown` and `keydown` listeners on the editor
root, the same attach point as the tap-to-edit `click` handler in
`main.ts`. It lives outside `main.ts` because that file sits at the
500-line cap.

- **Click vs. drag.** A press on `img[data-cell-index]` becomes a drag
  once the pointer moves `DRAG_THRESHOLD_PX = 8` (loose enough for a
  finger, tight enough that a tap never trips it); pointer capture
  then keeps the stream on the thumb. A capture-phase `click`
  listener swallows the synthetic click that follows a drag, so edit
  never co-fires. `pointermove`/`pointerup`/`pointercancel` are
  attached to `window` in the capture phase because ProseMirror's own
  handlers may stop propagation on the root.
- **Native drag.** Both `<img>` drag-and-drop and ProseMirror's node
  drag (the figure is `draggable`) fire `dragstart` on the placeholder
  and would take the pointer stream. `dragstart` is cancelled only
  between a thumb `pointerdown` and its `pointerup`, so a press
  elsewhere on the figure still moves the whole figure.
- **Drop slot.** `dropIndexFor2D` takes every thumb's rect, anchors on
  the one nearest the pointer, and decides before/after in reading
  order (row above → before, row below → after, same row → by the
  centre's x). A one-axis midpoint scan only worked for the first row
  of a wrapped grid. A vertical indicator bar sits at the slot; a
  clone of the thumb follows the pointer; within `EDGE_AUTOSCROLL_PX
  = 48` of the editor's top or bottom the container scrolls 12 px per
  frame. `.rkr-multi-thumbs` has `touch-action: none` so a finger drag
  on a thumb is not eaten by page scroll.
- **Commit.** The node is found by walking `doc.descendants` and
  matching `view.nodeDOM(pos)` to the placeholder (the same lookup the
  delete path uses; `posAtDOM` is ambiguous on atoms). One
  `setNodeMarkup` transaction per reorder, so one undo step.
- **Keyboard.** Thumbs render with `tabindex="0"`, `role="button"` and
  an `aria-label` naming their position. Arrows move one step;
  Enter/Space synthesise a click, which is the tap-to-edit path.
  After the transaction ProseMirror replaces the figure's DOM, so the
  figure position is captured before the commit and the moved thumb
  is re-resolved through `nodeDOM` on the next frame to restore focus.
- **Announcement.** The `aria-live` region is a single element on
  `<body>`, not a node inside the figure: the figure's `renderHTML`
  re-runs on every transaction and would wipe any text written into
  it. `data-reorder-status` is the hook the e2e asserts on.

Cross-figure moves would need a two-node transaction, deletion of an
emptied source figure and a slot-count rule for diptych/triptych
targets; they stay in `DEFERRED.md`.

## 8b. `@rkr/image-edit` and the standalone image editor

`packages/image-edit` holds the image-edit code both the blog and
`apps/image-pwa` run, so ops-model work lands once. The blog's server
already imported the op model at runtime (`ops-validation`,
`sidecar-types`, `image-constants` from the sidecar routes and the
figure widget), which fixed most of the shape:

- **npm workspaces, not tsconfig `paths`.** Node resolves
  `@rkr/image-edit` at runtime only through a real
  `node_modules/@rkr/image-edit`, which the workspace symlink
  provides; `paths` affects `tsc` alone. The sibling `wicketmap`
  monorepo gets by without the `workspaces` field because its shared
  package is only ever bundled.
- **Built JS, plus a `development` condition.** Node's strip-types
  loader refuses to strip files under `node_modules`, so the package
  emits `dist/{core,canvas}` (`tsc`, `rewriteRelativeImportExtensions`
  turns the `.ts` specifiers into `.js`) and `exports` points there.
  `npm test` and the c8 runs pass `--conditions=development`, which
  maps both entries to `src/` so tests and coverage see source without
  a build; `npm start` does not, so the server needs `build:packages`
  first (`typecheck` and `build` run it).
- **One package, two entries.** `.` is the DOM-free core, `./canvas`
  the browser layer, each with its own tsconfig (`lib: es2023` vs.
  `dom`). The server imports only `.`, so DOM types never enter its
  resolution graph; `tsconfig.core.json` is what keeps core DOM-free.
  The barrels re-export by name rather than `export *` so a leaf
  cannot widen the public API by accident.
- **Modals take an injected source.** `openCropper` and
  `openPerspective` used to take an image id and reach for the blog's
  `loadOriginal`/`getPipelineCache`/`setStatus`. In the package they
  take a decoded `CanvasSource`, a `PipelineCache`, the edit state and
  a status callback. The blog resolves those from its id-based loaders
  in `image-edit-panel.ts` (`withCanvasSource`); the PWA hands over the
  decoded `File`. The id/OPFS loaders, the LRU caches, the outbox and
  everything server-sync stay in `src/admin/`.

`apps/image-pwa` is glue over the package: file input or drop →
`resizeForUpload` (the same EXIF bake and long-edge clamp as a blog
upload) → `createImageBitmap` → `MemoryState`, a `LocalEditState`
driven by the core mutators with no server, OPFS or cross-tab
machinery → `PipelineCache.apply` into a data-URL preview → toolbar →
`canvas.toBlob(mime, quality)` and an anchor download. The tilt slider
is a `TiltSession`: each drag re-applies its absolute angle onto the
ops as they stood when the drag began, so one drag is one undo step
and an undo in between cannot leave the thumb out of step with the
image, which a delta-per-event slider does. `sw.ts` is install-only,
no caching, and is built to the app root rather than `dist/` because a
worker's default scope is its own directory and must cover the
manifest's `start_url` for the install prompt to appear.

Gate coverage: `type-check` fans out to both workspaces, knip reads a
`workspaces` map, biome globs by extension, and the org-hooks
duplicate-type and no-reexport checks take `packages/*/src`. The dpdm
circular check is still `src/**` only. The core is under the c8
per-file gate; the canvas layer needs a DOM and is measured by the e2e
V8 report instead (`TESTING.md`).

## 8c. OPFS write worker

`src/admin/opfs.ts` reads on the main thread and sends every write and
delete to `src/admin/opfs-worker.ts`, a dedicated module worker. The
split exists because `FileSystemFileHandle.createWritable()` is never
wired up for OPFS handles on iOS: the method is on the prototype, so
feature detection passes, and the first write throws a `TypeError` at
runtime. `createSyncAccessHandle()` is the write API every browser with
OPFS write support implements, and it exists only inside workers, so
all writes go through one. Reads, `navigator.locks`, the schema code
and everything above `opfs.ts` stay on the main thread unchanged.

- **Protocol** (`opfs-worker-msg.ts`): `{id, op: 'write', path, data}`
  or `{id, op: 'remove', path}`; the reply is `{id, ok: true}` or
  `{id, ok: false, error, isCapabilityError, debug?}`. `id` is a
  `crypto.randomUUID()` per request, so several requests can be in
  flight with no queue. A Blob is converted to an `ArrayBuffer` on the
  main thread and passed as a transferable.
- **Atomic write.** The worker writes `.<name>.tmp-<uuid>` beside the
  target through a sync access handle (`write` at 0, `flush`, `close`),
  then `move()`s it over the final name. If the sync handle throws, it
  retries the same temp file with `createWritable()`, which WebKit in
  some contexts and the test mock accept where the sync handle raises a
  `DOMException`. If both fail the temp file is removed and the error
  rethrown with both descriptions in `debug`. `remove` is silent on a
  missing file.
- **Capability vs. transient errors.** A `TypeError` (sync handle
  absent, iOS 16) or `DOMException` sets `isCapabilityError`; `opfs.ts`
  then calls `markOpfsUnsupported()`, `ensureSchema` reports
  `unsupported`, and the editor runs online-only. A failed script load
  (`worker.onerror`) rejects every pending request and takes the same
  path. Any other error rejects only its own request and reaches the
  caller as an ordinary write failure.
- **Build.** `build:admin` bundles the worker in a second esbuild call
  without `--splitting`, so `static/admin/opfs-worker.js` is
  self-contained. It is constructed from
  `/admin/static/admin/opfs-worker.js` so it sits in the admin service
  worker's scope (§8). `tsconfig.browser.json` lists `webworker` in
  `lib` beside `dom`, so one typecheck covers both sides.
- **Tests.** `atomicWriteWithRoot` and `removeFileWithRoot` take the
  root handle as an argument and run in Node against
  `test/admin/opfs-mock.ts`, whose `setNoSyncHandle` seam simulates the
  missing API. The `onmessage` wiring runs only in e2e through the real
  bundle.

## 9. CLI: `bin/site-admin`

Subcommand dispatch in `bin/site-admin` itself; per-command handlers
in `src/cli/<name>.ts`. The script is a Node shebang
(`#!/usr/bin/env node`) made available via `package.json`'s `bin`
field.

## 10. Deployment

`deploy.sh` drives it, with the site's settings in `deploy/sites/<site>.conf` over `deploy/common.conf`. `deploy/hooks/apache.build.post.sh` writes the vhost; `deploy/hooks/fastify_app.configure.post.sh` patches the systemd unit the `fastify_app` deploy type generates. Full step-by-step setup is in [RUNBOOK.md](./RUNBOOK.md).

Sharp on Debian/Ubuntu uses prebuilt binaries. On musl-based distros (Void, Alpine) build from source: install `vips-devel` then `npm install --build-from-source sharp`. Production is glibc; do not ship `node_modules` between dev and prod — install on target.

## 11. Build order with acceptance criteria

History — each step is roughly one PR; don't move to step N+1 until
step N's signal is green.

### Step 1 — Skeleton

- [x] Repo created with the layout in §2.
- [x] `package.json` committed.
- [x] `lib/db.ts` wrapper implemented; opens `:memory:` and a file path; basic round-trip test.
- [x] `bin/site-admin migrate` runs `001_initial.sql` against `$SITE_ROOT/data/site.db`.
- [x] `bin/site-admin init` creates `$SITE_ROOT` directory tree if absent, runs migrations.
- [x] `bin/server.js` starts a Fastify server, `GET /health` returns `200 {"ok":true}`.
- [x] `node --test` runs and at least one trivial test passes.
- [x] Apache vhost and systemd unit written; not deployed yet. (Both were static files then; they now come from `deploy/hooks/`.)

### Step 2 — Originals + sidecars

- [x] `lib/hash.ts` exports `sha256File`, `sha256Stream`, `canonicalJson`, `cacheKey`. All four covered by tests, including round-trip determinism.
- [x] `lib/sidecar.ts` exports `read(siteRoot, id)`, `write(siteRoot, id, data)`, `validate(data)`. Round-trip tested.
- [x] `POST /admin/upload` (multipart, no auth gate yet) writes to `originals/<id[0:2]>/<id[2:4]>/<id>.<ext>`, computes hash during stream, writes sidecar with `source.kind = 'upload'`.
- [x] Re-upload of byte-identical file is detected and dedup'd.

### Step 3 — Render pipeline

- [x] `lib/render.ts` `renderDerivative` produces deterministic output: same inputs → same bytes.
- [x] Cache hit: a second call with identical args returns `{cached: true}` without invoking Sharp.
- [x] Cache key changes when ops change.
- [x] `lib/jobs.ts` enqueue/dequeue/complete operations covered by tests, including atomic-claim race.
- [x] `GET /img/<filename>` on cache miss enqueues + renders + serves; on hit, the route is bypassed by Apache.

### Step 4 — CLI render and gc

- [x] `site-admin render` walks all sidecars, enqueues all declared variants, runs them to completion.
- [x] `site-admin render --force` re-renders existing.
- [x] `site-admin render --post <slug>` renders only that post's images.
- [x] `site-admin gc` deletes orphan cache entries; idempotent.
- [x] `site-admin verify` rehashes originals; flags any mismatch.

### Step 5 — Markdown rendering (no editor yet)

- [x] `lib/posts.ts` parses post `.md` files (frontmatter + body + directives) and serializes back. Round-trip on the fixture post is byte-identical.
- [x] `lib/widgets.ts` registry; image widget renders to `<picture>` with srcset matching the declared variants.
- [x] `GET /:slug` returns rendered HTML for the fixture post.
- [x] `GET /` returns a paginated index.
- [x] `site-admin reindex` populates the posts table from `content/posts/`.

### Step 6 — TipTap editor

- [x] TipTap bundled into the admin entry by esbuild.
- [x] Admin SPA loads at `/admin/editor`.
- [x] Image block: upload, displays a preview, edits alt text, crop UI, saves a post that round-trips through markdown.
- [x] No markdown syntax visible in the editor at any point.

### Step 7 — Remote import

- [x] Plain URL import: `POST /admin/import/url`, with size cap and content-type allowlist enforced.
- [x] Google Drive: Picker API + `drive.readonly` scope; OAuth tokens stored encrypted.
- [x] OneDrive: server-side ready; picker SDK integration deferred until an MS Entra app is registered.
- [ ] Dropbox: deferred.

### Step 8 — Multi-image widgets

- [x] Gallery widget with justified/masonry/matrix layouts.
- [x] Carousel widget with scroll-snap track + autoplay/keyboard/dot indicators.
- [x] Diptych/triptych widgets.
- [x] Lightbox script for all non-inline figures.

### Step 9 — Auth

- [x] OAuth via `arctic`. Invite-only allowlist.
- [x] All `/admin/*` routes (except login + OAuth callback) require valid session.
- [x] `POST /admin/upload` from step 2 is now gated.

### Step 10 — Public theme

- [x] CSS, fonts, header/footer, post template, index template.
- [x] No JS on the public side except the lightbox + carousel scripts and native `loading="lazy"` on images.
- [x] Mobile-responsive.
- [ ] Apache vhost deployed to a staging VPS; full smoke test.

### Step 11 — Image-edit local pipeline (Phases 1–3)

- [x] Sidecar `redoStack` field; ops execute in click order with per-op simplification.
- [x] Edits-list panel with delete-step, undo, redo, reset.
- [x] `GET /admin/original/:id` streams the master so the client can decode once per session.
- [x] Per-image `PipelineCache` for incremental "added one op" execution.
- [x] `POST /admin/sidecar/:id/commit` atomically saves ops + WebP bake in one multipart request; stores `bakes/<id>.webp` and invalidates stale cache derivatives. `renderDerivative` prefers the bake.
- [x] `LocalEditState` with explicit "Save edits" button. Dirty/clean flips Save button state.
- [x] Cropper sources from the local post-ops canvas; crop appends to ops.
- [x] Post-Save auto-commits dirty image edits; `beforeunload` warns; LRU caps in-browser caches.

### Step 12 — Perspective rectify (Phase 4)

- [x] Server-side validation of `{type:'perspective', corners:[[x,y]×4]}` op shape.
- [x] Client `applyPerspective` via WebGL: vertex shader Y-flip, fragment shader inverse homography.
- [x] 4-corner drag modal (Pointer Events + SVG quad overlay).
- [x] Math helpers: `computeHomography`, `invertMatrix3`, `perspectiveOutputSize`.
- [x] Server-side coord cap (≤100k); degenerate-quad UI feedback; WebGL-availability gate on the perspective button.

### Step 13 — PWA shell + service worker

- [x] `static/admin-manifest.webmanifest` + 192/512 icons.
- [x] `<link rel="manifest">` in public templates (`layout.ts`,
      `post.ts`, `index.ts`).
- [x] `src/site/sw-admin.ts` event-listener glue +
      `src/site/sw-admin-core.ts` pure cache/route logic. One cache,
      `rkr-admin-<hash>`, from the precache manifest — new HTML can
      never pair with old chunks, and `evictOldCaches` drops every
      other `rkr-admin-` cache on activate.
- [x] `handleFetch` handles two kinds of GET and lets the rest reach
      the network untouched. A `navigate` to `/admin/editor` or
      `/admin/view/*` is network-first, writing each ok response back
      and falling back to the shell (cached under `/admin/editor`
      whatever the path was, since the shell is slug-independent), then
      to a 503. `/admin/static/*` is cache-first — immutable for a
      given hash — with a network fallback. `/admin/api`,
      `/admin/posts` and `/admin/post-bundle` are among the untouched:
      the outbox owns their offline behavior.
- [x] `src/site/sw-admin-register.ts` registers the admin SW at scope
      `/admin/`. Loaded only from the admin SPA template.
- [x] `src/site/sw-unregister.ts` loaded on all **public (anon) pages**
      instead of sw-register. Actively unregisters any previously
      installed SW at scope `/` so casual readers don't retain stale
      offline caching. Also strips the `?_rkr` cache-bust param and
      posts `rkr-pages-flush` to any still-active SW controller before
      unregistering. `src/admin/save.ts` posts the same message. No
      worker listens for it — it is a leftover from the public-page SW
      that no longer ships.
- [x] Content-hashed bundles via esbuild; bundle-size ratchet
      via `scripts/bundle-size-baseline.json`.

### Step 14 — Offline outbox + drain (admin SPA)

- [x] OPFS abstraction (`opfs.ts`) with versioned schema
      (`opfs-schema.ts`).
- [x] Outbox model (`outbox.ts`): `upload` / `commitImageEdit` /
      `savePost` ops with coalesce-on-append.
- [x] Leader-elected drain (`sync.ts`) via `navigator.locks`;
      BroadcastChannel('rkr-sync') for status; per-entry retry
      with jitter backoff (`drainers.ts`).
- [x] `online-state.ts` state machine: online / verifying / offline
      via `navigator.onLine` + 5s `/health` HEAD probe.
- [x] `status-badge.ts` bottom-right indicator.
- [x] Save-waits-for-uploads guard: `extractFigureIds` blocks
      `savePost` until referenced uploads drain.
- [x] e2e: `test/e2e/offline-resilience.spec.ts` covers multi-op
      queue, retry-with-backoff, intermittent drain recovery,
      persistent-5xx halt, save-waits-for-uploads.

### Step 15 — Pin existing posts + eviction

- [x] `GET /admin/post-bundle/:slug` returns the full post JSON
      (markdown + frontmatter + sidecar refs) for offline load.
- [x] `pin.ts` toggles pinned vs cached state in OPFS.
- [x] `eviction.ts` 7-day TTL + reference-counted original
      reclamation; runs on editor mount + after drain-empty.
- [x] `storage-panel.ts` shows usage, pinned/cached lists, pending
      sync queue, manual controls.

## 12. Comments

### Storage

Migration `004_comments.sql` adds a `comments` table. Web submissions
arrive with `status = 'pending'`; the `source` column distinguishes
`'web'` from `'wp-import'`. One-level threading only: `src/lib/comments.ts`
enforces that a web reply's `parent_id` must reference a `published`
top-level comment (no `parent_id` of its own).

### Spam triage (async)

Submit → `pending` row written + `classify` job enqueued on the existing
`jobs` table → the in-process worker's classify handler calls the Ollama
proxy (`SPAM_MODEL`, default `llama3.2:3b`, at `OLLAMA_BASE_URL`, Bearer
token from `OLLAMA_TOKEN`) → ham auto-publishes; spam, timeout, or any
failure leaves the comment `queued` for manual review (fail-safe: unscored
comments never auto-publish). Retries live inside the classifier
(`SPAM_MAX_ATTEMPTS` attempts per job invocation, default 3) because the
`jobs` table has no built-in auto-retry — a deliberate, faithful
realization of the spec's "bounded retries, queue on failure". If
`OLLAMA_BASE_URL` is unset (or the proxy is unreachable), the classify job
fails safe: after bounded retries the comment is set to `queued` for manual
review.

The classifier (`src/lib/spam-classifier.ts`) POSTs a pinned prompt
with `format: 'json'` to `/api/generate` and parses a
`{verdict, score, reason}` object; the prompt carries author name,
email, and body only. Each attempt is bounded by `SPAM_TIMEOUT_MS`
(default 8000) with a `(attempt-1) × 200 ms` pause between attempts.

### Anti-abuse (pre-LLM)

`src/routes/public-comments.ts` runs the cheap checks before any row is
written. A filled honeypot (`website`) returns the same response as a
real submission and inserts nothing, so a script cannot tell it was
filtered. Length caps (80 / 200 / 5000), an email-shape regex, and
control-character rejection come next, then the per-IP rate limit (5
per 10 minutes via `@fastify/rate-limit`). A submission whose hidden
`t` render timestamp is under 3 s old is inserted and set straight to
`queued`, skipping the classify job: it is already distrusted, so no
GPU time is spent on it.

The honeypot's hiding rule lives in `static/base.css`, which every
page loads before any theme, because a visible honeypot is a
functional bug (a reader who fills in "Website" is silently dropped),
not a cosmetic one, and must not depend on the active theme. It is
clipped to 1 px rather than `display:none` because some bots skip
`display:none` inputs.

### Form and comment bubble

`src/templates/comments.ts` renders the list and the form; the form
is Name / Email / Comment plus hidden `t`, optional `parent_id`, and
the honeypot. `author_url` was dropped in migration `005` and names
render as plain text. `src/site/comment-form.ts` intercepts submit and
re-POSTs the same form body over `fetch` with `x-rkr-ajax: 1`; the
route answers that header with `200 {ok, notice}` instead of the 303,
and the script swaps the notice in. The two "accepted" responses are
byte-identical between a real submission and a honeypot hit.

The bubble in the post header (`src/templates/post.ts`) is an anchor
to `#respond` with `countThread` (`src/lib/comment-types.ts`) summing
top-level comments and their replies. It is absolutely positioned at
the header's top-right, mirroring the Twenty Eleven treatment on the
WordPress source site; putting it inline after the copy-link button
was rejected because two right-aligned controls collide on long
titles. Like `.rkr-post-copylink`, it is styled only in
`static/themes/default.css`; the other themes inherit it.

### Email notification

A `notify` job kind (`src/lib/notify-handler.ts`) sends one plain-text
email per resolved comment through `src/lib/mailer.ts` (nodemailer).
It is a separate job from `classify` so SMTP latency or failure never
touches classification, and the single worker serialises sends.

The level gate runs at enqueue time, not in the handler, so no dead
jobs reach the queue: `classify-handler.ts` enqueues after
`applyClassification` when `siteConfig().commentNotify` (default
`ham`) covers the resulting status, and `public-comments.ts` does the
same for the too-fast path, which never sees the classifier. Changing
the level in Settings therefore affects only later comments. The
handler loads comment and post, branches subject on `published` vs
`queued`, and returns quietly if the comment is missing or in any
other status. `classify-handler.ts` takes `enqueue` as an argument
rather than importing it, because `jobs.ts` imports the handler and
the circular gate would fail.

The mailer never throws: unconfigured (`SMTP_HOST` or recipient
unset) returns `{sent:false}` with a one-shot stderr warning, and a
transport error is logged and swallowed. The job completes either
way, since `jobs.ts` has no auto-retry and a thrown handler would sit
`failed` forever. The recipient is resolved at send time from the
persisted `notifyEmail`, falling back to `NOTIFY_TO`; subject, from,
and to are stripped of CR/LF. Plain text only, so there is no escaping
surface.

### Moderation

Server-rendered `/admin/comments` lists queued comments first, then
published, then rejected. Approve, reject, and delete actions. Gated by
the existing admin auth (`requireUser`).

### WordPress import

`site-admin import-wp-comments <wp-base-url>` fetches approved comments
from the WP REST API and inserts them as `published` / `source='wp-import'`
without classification. Idempotent: `wp_comment_id` has a UNIQUE
constraint. Threads deeper than one level are flattened to top-level, as
is a reply whose parent lands on a later page. The public API exposes no
commenter email, so `author_email` is the sentinel `imported@roll-along`.
Bodies are stripped to text since comments are stored raw and escaped on
render.

## 12a. Search

Migration `006_search_fts.sql` creates `posts_fts`, a standalone FTS5
table (`slug UNINDEXED, title, tags, body`, `tokenize = 'porter
unicode61'`). It is not an external-content table because `posts`
does not hold body text: the filesystem is the source of truth and
this table is the only place the body is indexed. `slug` is stored
purely for the join back to `posts`.

`doReindex` (`src/lib/post-index.ts`) already parses every
`content/posts/*.md`; it keeps the mdast and, inside the same upsert
transaction, does `DELETE FROM posts_fts WHERE slug = ?` then
`INSERT`, with `tags` as the tag names joined by spaces and `body`
from `extractPlainText` (`src/lib/post-text.ts`). A slug rename
matched by path deletes the old slug's row; orphan cleanup deletes
rows for removed files; `_`-slugs are skipped. Hooking population into
reindex, which every save and delete already calls, means there is no
incremental index path to keep correct.

`extractPlainText` walks the tree and joins `text` and `inlineCode`
values with single spaces, skipping `yaml`, fenced `code`, and the
three directive node types.

`buildFtsMatch` (`src/lib/search-query.ts`) trims and caps the query
at 200 characters, replaces everything outside `\p{L}\p{N}_` and
whitespace with spaces, splits, and returns `null` when no token
survives. Tokens are joined by spaces (FTS5 implicit AND) and the last
gets a `*`. Stripping every syntax character is what makes the MATCH
argument safe to bind untouched.

`GET /search` (`src/routes/public-search.ts`) runs one query:
`snippet(posts_fts, 3, char(1), char(2), '…', 12)` on the body column,
joined to `posts` for `status`/`published_at` scoping
(`p.status = 'published' OR ? = 1` with `isAdmin`), `ORDER BY
bm25(posts_fts, 0.0, 10.0, 5.0, 1.0)` (the leading `0.0` is the
unindexed slug column), `LIMIT 50`. The snippet is HTML-escaped whole
and only then are the U+0001/U+0002 sentinels swapped for
`<mark>`/`</mark>`, so a literal `<mark>` in a post cannot be
injected. The route probes `posts_fts` once at registration and, while
absent, once per request, so a database that has not run `006` yet
returns an empty result set instead of an error and picks the table
up as soon as a reindex creates it.

The search form is `renderSearchForm` in `src/templates/layout.ts`,
placed by the index and search templates in the tag rail next to the
sort toggle; the search page (`src/templates/search.ts`) reuses
`.post-list` and adds `.rkr-search-snippet`.

## 12b. System posts and `/about`

A `_`-prefixed slug marks a system post. `post-index.ts` skips it for
both indexing and orphan cleanup, so it lives on disk with no `posts`
row, and `GET /:slug` 404s any `_` slug so no system post is reachable
by its file name. `_site-banner` is embedded into the header;
`_about` needs its own route.

`GET /about` (`src/routes/public.ts`) reads `content/posts/_about.md`
directly, and any read or parse failure is a 404 rather than a 500.
It renders through `renderPostPage` with `showComments: false`, which
drops the bubble, list, and form. A flag was chosen over a separate
page template because the head, header, title, banner, and prose
width are identical; one renderer is the smaller change. `isValidSlug`
already accepts `_` slugs, so the editor, bundle, and save pipeline
edit `_about` unchanged.

`GET /admin/about/edit` (`admin-settings.ts`) writes a stub
(`slug: _about`, `title: About`, `status: published`) if the file is
absent and redirects to `/admin/editor?slug=_about`; the settings page
shows `Create About` or `Edit About →` by file presence, mirroring the
banner link.

`import-wp about` calls `pushPage` (`src/lib/wp-push.ts`), which
fetches a WordPress page (`fetchWpPage`, `wp/v2/pages?slug=`) and sets
`page.slug = '_about'` before handing it to the same `pushWpObject`
path `pushPost` uses. A WP page has the fields the importer consumes,
and the emitted frontmatter slug is whatever the fetched object says,
so overwriting `.slug` is all it takes to land it as the system post.

### Content sources

`src/lib/wp-source.ts` defines `WpSource`: the set of reads the import
pipeline needs from a WordPress site — posts, pages, comments, site
info, featured media, images, tag names. Two implementations:

- `restSource` (same file) wraps the REST client in `src/lib/wp-rest.ts`.
- `sqliteSource` (`src/lib/wp-sqlite.ts`) reads a `mariadb-dump` file
  converted to SQLite by `src/lib/wp-dump.ts`, plus the site's
  `wp-content/uploads` tree on disk. No network access.

`convertDump` builds into a sibling temp file and renames into place
only once the whole dump has converted, so a malformed statement
partway through leaves any existing database untouched rather than a
half-loaded one.

`importPost` and `pushPost` already accepted injectable `fetchImage` and
`fetchTagNames`, so neither the HTML→markdown emitter nor the push path
knows which source it is running against. The CLI picks one from
`--from-dump`.

The backup source reads raw `post_content` (Gutenberg HTML) where the
REST source gets `content.rendered`. The difference that matters is
`srcset`: without it there is no way to pick the full-size image from
the markup, so `sqliteSource` annotates each `<img src>` with
`#wp-image-<id>` from its `wp-image-<id>` class and
`src/lib/wp-sqlite-images.ts` resolves that id through
`_wp_attached_file` to the original on disk. That reaches the true
original rather than the resized variant WordPress wrote into the page.

Two behaviours the backup source must preserve because the REST API
enforced them implicitly: comments are filtered to
`comment_approved = '1'` and `comment_type IN ('', 'comment')`, and a
post's WordPress status decides the pushed status unless `--status` says
otherwise — the public REST API never returned drafts, so nothing
previously had to check.

WordPress leaves `post_name` empty until a post is first published, so
draft slugs are derived from the title via `slugify`. A slug lookup
falls back to matching that derived value, or the slug the CLI prints
could not be used to fetch the post.

## 13. Open decisions

Pinned implementation calls; revisit if real-world data contradicts.

1. **Markdown directive serializer**: TipTap output → markdown
   round-trip via a small custom plugin atop `remark-stringify`.
2. **Sync vs async render budget on miss**: 8 s default. Long enough
   that the 202+placeholder fallback only fires for genuinely slow
   variants. Retune once production timings exist.
3. **AVIF cost/benefit**: encoding is ~10× slower than WebP. Currently
   eager (rendered ahead of time via `site-admin render`); can shift to
   on-demand if publish latency hurts.
4. **Bundling vs vendoring TipTap**: bundled via esbuild. CDN-with-SRI
   was rejected in favor of an offline-capable, CSP-tight bundle.

## 14. Markdown → HTML rendering: the image map

`renderPostHtml` (`src/lib/content.ts`) and every widget's `WidgetCtx`
take a prebuilt `images: ImageMap` (`src/lib/image-map.ts`) instead of
a `siteRoot`, so the renderer does no filesystem I/O and bundles for
either environment — a server request handler in `src/routes/public.ts`
or the admin preview running in the browser. The map is keyed by the
id as written in the post, lowercased; a missing key means
unresolvable, and the widget renders an HTML comment
(`<!-- figure: unresolved id ... -->`) instead of a `<picture>`.

Gather first, then render:

- Both prepasses take mdast nodes, not markdown text.
  `collectFigureIds` (`src/lib/figure-ids.ts`) walks them for `::figure`
  directives and reads each `ids` attribute with
  `extractImageIdsAndAlts` — the same parse the figure widget renders
  from, so the map's keys and the widget's lookups agree by
  construction. A hex token in prose or a code block is not a
  directive attribute, so it is never resolved, measured, or baked.
- `src/lib/image-map-fs.ts` builds the map from disk — sidecars,
  on-disk dimensions, `/img/<id>.<oph>.<fmt>` URLs.
- `src/admin/image-map-opfs.ts` builds the same shape from OPFS —
  `blob:` URLs, dimensions falling back to the sidecar's recorded
  values, since there's no sharp in the browser.
- `src/lib/id-resolve.ts` holds the one copy of the id-prefix
  resolution rule. Both prepasses call it, as do `posts.ts`'s
  image/video scanners and `/admin/preview/:id`.

Callers pass whatever subtree they are about to render: a whole `Root`
for `/about` and `/:slug`, the hero figure plus lede for the index
teaser, the single `::figure` node for the site banner. The
`bannerImageId` fallback builds its figure node first and hands over
that node, so the id path is the same one every other caller takes.

An injected filesystem port into the renderer was considered and
rejected: it wraps the reads rather than removing them, and leaves the
widgets async against an abstraction. Gathering first also lets the
server resolve every image concurrently instead of serially
mid-render, and makes `renderPostHtml` testable from a hand-written
map with no stubs.

`test/lib/image-map-equivalence.test.ts` renders one fixture post
through both prepasses and asserts the resulting HTML matches, once
URLs are normalized — the check that keeps the two builders honest as
either one changes.
