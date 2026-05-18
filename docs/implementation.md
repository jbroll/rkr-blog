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
| `src/widgets/` | Public renderer widget — `::figure` only |
| `src/admin/` | Editor browser bundle (esbuild → `static/admin/`): ~40 files covering editing, image ops, offline sync, and settings |
| `src/site/` | Public-page browser scripts (esbuild → `static/site/`): lightbox, carousel, comment form, service worker |
| `src/templates/` | Server-side HTML templates (TypeScript template literals) |
| `src/routes/` | Fastify route modules (one per concern) |
| `src/cli/` | One file per `site-admin` subcommand |
| `test/` | Unit + integration tests mirroring `src/` layout; e2e specs under `test/e2e/` |
| `migrations/` | Numbered SQL migration files applied by `site-admin migrate` |
| `deploy/` | Apache vhost template and systemd unit |

The runtime data tree (`originals/`, `sidecars/`, `bakes/`, `cache/`,
`content/`, `data/`) lives **outside** the repo, configured via
`SITE_ROOT` (default `/var/www/site`). The repo is portable; the data
is not.

## 3. Runtime data layout (deployed paths)

```
$SITE_ROOT/
  originals/
    ab/cd/abcd1234ef….jpg              # 2/2 prefix sharding by id
  sidecars/
    abcd1234ef….json
  bakes/
    ab/cd/abcd1234ef….webp             # always WebP at q=0.95
  cache/
    img/                               # served directly by Apache
      abcd1234ef….<ophash>.webp
      abcd1234ef….<ophash>.avif
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
     full ops chain in sharp. Sharp can't apply `perspective`; if
     the ops list contains it AND the bake is missing,
     `renderDerivative` throws `unknown op type`. The bake is
     authoritative for perspective.
5. Write to a temp file; atomic rename into place.
6. Concurrency: `sharp.concurrency(1)` per call so libvips threads
   don't multiply with job concurrency.

### Client: `src/admin/canvas.ts` and `canvas-math.ts`

`canvas-math.ts` is DOM-free so the server-side test runner can import
it. Holds:

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

`canvas.ts` is the DOM-touching half:

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

### Magic-byte validation

`POST /admin/sidecar/:id/commit` checks the bake body starts with
`RIFF????WEBP` and decodes it via sharp before writing. Body is capped at
25 MB (`BAKE_MAX_BYTES`); WebP at q=0.95 for a 50 MP source is ~5–10 MB so
real bakes are well under.

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
   (`renderBudgetMs`, default 30 s).
5. On success within budget: `200` with the bytes (and Apache picks up
   subsequent requests from disk).
6. On budget exceeded: enqueues the job, returns `202` + a low-res
   placeholder, client retries.

The 30 s default sizes for a low-end VPS rendering large variants;
the spec just calls for "configurable wall-clock budget" without
fixing the number. Override via `BuildAppOpts.renderBudgetMs` when
constructing the app (currently only used by tests).

## 7. Front proxy (Apache vhost)

The vhost template lives at `deploy/apache.conf`. Key behaviours:

- `mod_rewrite` checks whether the requested `/img/*` path exists on disk; if so it rewrites directly to the `cache/img/` file, bypassing Node entirely.
- Everything else proxies to `localhost:3000`.
- `cache/` and `static/` responses carry `Cache-Control: public, max-age=31536000, immutable`. The `immutable` flag is accurate because cache filenames are content-hashed.

Required modules: `rewrite`, `proxy`, `proxy_http`, `headers`, `expires`.

## 8. Editor browser bundle

`tsconfig.browser.json` covers `src/admin/**`, `src/site/**`, and the
two shared lib files the admin bundle pulls in (`prose-markdown.ts` +
`safe-url.ts`). The admin bundle is built with esbuild (TipTap +
ProseMirror + Cropper.js), ESM format with code-splitting:

- `static/admin/main.js` — editor SPA (TipTap, image ops, offline sync)
- `static/admin/posts-list.js` — post list page
- `static/admin/settings-page.js` — settings page
- `static/site/lightbox.js` — public-page lightbox
- `static/site/carousel.js` — public-page carousel runtime
- `static/site/comment-form.js`, `copy-link.js`, `img-retry.js` — lightweight public-page helpers
- `static/site/sw-unregister.js` — loaded on all public pages; actively unregisters any prior SW at scope `/`
- `static/site/sw-admin.js` + `sw-admin-register.js` — admin PWA service worker and registration script

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

## 9. CLI: `bin/site-admin`

Subcommand dispatch in `bin/site-admin` itself; per-command handlers
in `src/cli/<name>.ts`. The script is a Node shebang
(`#!/usr/bin/env node`) made available via `package.json`'s `bin`
field.

## 10. Deployment

See `deploy/apache.conf` for the vhost template and `deploy/systemd.service` for the systemd unit. Full step-by-step setup is in [developer-quickstart.md](./developer-quickstart.md).

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
- [x] `deploy/apache.conf` and `deploy/systemd.service` written; not deployed yet.

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

- [x] `static/manifest.webmanifest` + 192/512 icons.
- [x] `<link rel="manifest">` in public templates (`layout.ts`,
      `post.ts`, `index.ts`).
- [x] `src/site/sw-admin.ts` event-listener glue + `src/site/sw-core.ts`
      pure cache/route logic. Three caches:
      `rkr-shell-v<hash>`, `rkr-pages-v<hash>`, `rkr-images-v<hash>`.
- [x] Cache-first for `/img/*`, SWR for `/static/*` + page navs;
      `Cache-Control: no-store` opt-out for session-private bodies.
- [x] `src/site/sw-admin-register.ts` registers the admin SW at scope
      `/admin/` and listens for the `rkr-pages-flush` postMessage.
      Loaded only from the admin SPA template.
- [x] `src/site/sw-unregister.ts` loaded on all **public (anon) pages**
      instead of sw-register. Actively unregisters any previously
      installed SW at scope `/` so casual readers don't retain stale
      offline caching. Also strips the `?_rkr` cache-bust param and
      posts `rkr-pages-flush` to any still-active SW controller before
      unregistering.
- [x] Content-hashed bundles via esbuild; bundle-size ratchet
      via `coverage-baseline.json` sibling `bundle-size-baseline.json`.

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
- [x] e2e: `test-e2e/offline-resilience.spec.ts` covers multi-op
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

### Anti-abuse (pre-LLM)

Honeypot field (hidden input; any fill → `queued`), minimum fill-time
check (too-fast submit → `queued`), per-IP rate limit (5 submissions per
10 minutes via `@fastify/rate-limit`), and length caps on name/body.

### Email notification

`src/lib/notify-handler.ts` fires on every new web submission (before triage) and sends an email via `src/lib/mailer.ts` (nodemailer). The mailer is a no-op when `SMTP_HOST` is unset, so notification is opt-in at deploy time.

### Moderation

Server-rendered `/admin/comments` lists queued comments first, then
published, then rejected. Approve, reject, and delete actions. Gated by
the existing admin auth (`requireUser`).

### WordPress import

`site-admin import-wp-comments <wp-base-url>` fetches approved comments
from the WP REST API and inserts them as `published` / `source='wp-import'`.
Idempotent: `wp_comment_id` has a UNIQUE constraint. Threads deeper than
one level are flattened to top-level.

## 13. Open decisions

Pinned implementation calls; revisit if real-world data contradicts.

1. **Markdown directive serializer**: TipTap output → markdown
   round-trip via a small custom plugin atop `remark-stringify`.
2. **Sync vs async render budget on miss**: 30 s default. Generous
   so the 202+placeholder fallback only fires for genuinely slow
   variants. Tune lower once production timings exist.
3. **AVIF cost/benefit**: encoding is ~10× slower than WebP. Currently
   eager (rendered ahead of time via `site-admin render`); can shift to
   on-demand if publish latency hurts.
4. **Bundling vs vendoring TipTap**: bundled via esbuild. CDN-with-SRI
   was rejected in favor of an offline-capable, CSP-tight bundle.

## 14. Sample fixtures

`test/fixtures/posts/2026-05-06-first-post.md`, sample sidecars, and
small JPEG/PNG images (under 100 KB each, varied aspect ratios, one
with embedded EXIF orientation) live in `test/fixtures/`. They're
committed and used by the test suite.
