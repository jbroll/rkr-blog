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

```
rkr-blog/
├── bin/
│   ├── site-admin            # CLI entry point (Node shebang)
│   └── server.js             # Fastify entry point
├── src/
│   ├── lib/                  # framework-agnostic library code
│   │   ├── db.ts             # node:sqlite wrapper
│   │   ├── hash.ts           # canonical-JSON, sha256, cache-key derivation
│   │   ├── sidecar.ts        # read/write/validate sidecars
│   │   ├── render.ts         # renderDerivative + Sharp pipeline
│   │   ├── jobs.ts           # job queue operations
│   │   ├── posts.ts          # post markdown read/parse/serialize
│   │   ├── prose-markdown.ts # TipTap JSON ⇄ markdown directive round-trip (bundled into the admin browser bundle; not server-side at runtime)
│   │   ├── safe-url.ts       # URL-scheme allowlist (shared by content.ts + prose-markdown.ts)
│   │   ├── widgets.ts        # widget registry, dispatch
│   │   ├── content.ts        # HTML escape, sanitize
│   │   ├── render-formats.ts # constants for output format/quality
│   │   ├── url-safety.ts     # SSRF guard for /admin/import/url
│   │   ├── secrets.ts        # AES-256-GCM token encryption
│   │   ├── google-jwt.ts     # ID-token verify
│   │   ├── google-drive.ts   # picker + drive v3 client
│   │   ├── microsoft-graph.ts# OneDrive picker + Graph API client
│   │   ├── csrf.ts           # CSRF Origin/Referer guard for state-changing methods
│   │   ├── auth-middleware.ts# requireUser
│   │   ├── sessions.ts       # server-side session table
│   │   ├── users.ts          # users + allowlist + oauth_accounts
│   │   ├── oauth-tokens.ts   # encrypted picker tokens
│   │   ├── config.ts         # env-var resolution
│   │   └── migrate.ts        # numbered SQL migrations
│   ├── widgets/              # one file per widget directive
│   │   ├── image.ts
│   │   ├── gallery.ts
│   │   ├── carousel.ts
│   │   └── diptych.ts        # diptych + triptych
│   ├── admin/                # browser bundle (esbuild → static/admin/)
│   │   │                     # ~35 files; bucketed by feature here.
│   │   ├── main.ts           # editor SPA entry (500-line cap)
│   │   ├── startup.ts, toolbar.ts, dom.ts, dialog-focus.ts
│   │   │                     # editor scaffolding + cross-module glue
│   │   ├── save.ts, draft.ts, page-title.ts, attr-commit.ts
│   │   │                     # post save + draft persistence + status bar
│   │   ├── posts-list.ts, pin.ts
│   │   │                     # /admin posts table + pin-to-home toggle
│   │   ├── image-insert.ts, drag-drop.ts, pick.ts, upload.ts
│   │   │                     # insert paths: dialog, drag-drop, picker, file
│   │   ├── local-thumb.ts, ingest-resize-client.ts
│   │   │                     # client-side ingest resize before upload
│   │   ├── image-edit.ts, image-edit-panel.ts, figure-node.ts
│   │   │                     # per-image ops + figure attribute panel
│   │   ├── matrix-control.ts, cropper-modal.ts, perspective-modal.ts
│   │   │                     # grid picker, cropper, perspective rectify
│   │   ├── canvas.ts, canvas-loaders.ts
│   │   │                     # WebGL pipeline + image loader cache
│   │   ├── opfs.ts, opfs-schema.ts
│   │   │                     # OPFS abstraction + versioned schema
│   │   ├── outbox.ts, sync.ts, drainers.ts
│   │   │                     # offline queue + leader-elected drain
│   │   ├── eviction.ts, storage-panel.ts
│   │   │                     # LRU + 7-day TTL + storage UI
│   │   ├── online-state.ts, status-badge.ts
│   │   │                     # navigator.onLine + HEAD probe state machine
│   │   └── integrations/{gdrive,onedrive}.ts
│   │                         # cloud-picker shims (server endpoints in routes/)
│   ├── site/                 # browser bundle (esbuild → static/site/)
│   │   ├── lightbox.ts
│   │   ├── carousel.ts
│   │   ├── sw.ts             # service worker — event-listener glue
│   │   ├── sw-core.ts        # SW logic, pure (Node-testable via mock cache)
│   │   └── sw-register.ts    # page-side SW registration + auth-flush hook
│   ├── templates/            # public-facing templates (template literals)
│   │   ├── layout.ts
│   │   ├── post.ts
│   │   ├── index.ts
│   │   └── admin.ts          # editor SPA shell
│   ├── routes/               # Fastify plugin modules
│   │   ├── public.ts
│   │   ├── admin.ts
│   │   ├── auth.ts
│   │   ├── integrations-gdrive.ts
│   │   └── integrations-onedrive.ts
│   ├── cli/                  # one file per `site-admin` subcommand
│   │   ├── init.ts
│   │   ├── migrate.ts
│   │   ├── render.ts
│   │   ├── reindex.ts
│   │   ├── gc.ts
│   │   ├── verify.ts
│   │   ├── jobs.ts
│   │   ├── user.ts
│   │   ├── reset.ts
│   │   ├── import-wp.ts
│   │   └── server.ts
│   └── server.ts             # buildApp() for tests + bin/server.js
├── test/                     # mirrors src/ layout (server-side unit suite)
│   ├── lib/, routes/, widgets/, cli/
│   ├── site/                 # browser-only code unit-tested in Node
│   │                         # (sw-core etc. — paths Playwright can't
│   │                         # reach because the SW runs in its own
│   │                         # thread)
│   └── fixtures/
│       ├── images/           # small JPEGs/PNGs (committed)
│       └── posts/, sidecars/
├── migrations/
│   ├── 001_initial.sql
│   └── 002_auth.sql
├── deploy/
│   ├── apache.conf           # vhost template
│   └── systemd.service       # systemd unit
├── biome.json
├── tsconfig.json             # server-side TS (strict, noEmit, type-strip)
├── tsconfig.browser.json     # admin/site → static/
├── package.json
├── README.md
├── spec.md
├── implementation.md         # this document
└── developer-quickstart.md
```

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

### `lib/db.ts` interface

```ts
export function open(path: string): DB;

interface DB {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  transaction<T>(fn: (db: DB) => T): T;
  pragma(name: string, value?: string): unknown;
  close(): void;
}

interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
  iterate(...params: unknown[]): AsyncIterator<Row>;
}
```

`iterate` calls `all()` and yields each row — not a streaming reader.
If a streaming need appears, swap the driver or paginate at the call site.

`node:sqlite` requires `--experimental-sqlite` on Node 22 (unflagged on
24+). The server and CLI both run with `--no-warnings=ExperimentalWarning`
to suppress the stderr notice.

### Schema (migrations/001_initial.sql)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  path TEXT NOT NULL                  -- relative path under content/
);
CREATE INDEX posts_status_published ON posts(status, published_at DESC);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                 -- 'render'
  payload TEXT NOT NULL,              -- JSON: {originalId, ops, variant, output}
  state TEXT NOT NULL                 -- 'queued','running','done','failed'
    CHECK (state IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cache_key TEXT UNIQUE               -- dedupe: same derivative not enqueued twice
);
CREATE INDEX jobs_state_created ON jobs(state, created_at);
```

### Schema (migrations/002_auth.sql)

```sql
DROP TABLE IF EXISTS auth;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS oauth_tokens;

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner','editor')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE oauth_accounts (
  provider TEXT NOT NULL,             -- 'google'
  provider_sub TEXT NOT NULL,         -- the OAuth subject id
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_sub)
);
CREATE INDEX oauth_accounts_user ON oauth_accounts(user_id);

CREATE TABLE allowed_emails (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('owner','editor')),
  invited_at TEXT NOT NULL,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                -- 32 random bytes hex
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE oauth_tokens (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,             -- 'gdrive', 'onedrive'
  access_token BLOB NOT NULL,         -- encrypted
  refresh_token BLOB,                 -- encrypted
  expires_at TEXT NOT NULL,
  scope TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);
```

The posts table is an **index** over the markdown files, not the
source of truth. `site-admin reindex` rebuilds it from the
filesystem.

### Migration strategy

```
migrations/
  001_initial.sql
  002_add_xyz.sql
```

`site-admin migrate` reads the directory, sorts numerically, applies
any version not yet in `schema_migrations` inside its own
transaction. No down-migrations in v1; rollback by restore from
backup.

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
- `saveImageEdits(id, s)` — POSTs ops + redoStack, then if there's
  ops uploads the WebP bake; updates `baseline` only after both
  calls land.
- `flushDirtyImageEdits()` — saves every dirty image in parallel
  via `Promise.allSettled`; called by both the per-image **Save
  edits** button and the post-Save flow (so saving the post auto-
  commits any dirty image edits first; partial-failure aborts the
  post save).
- `beforeunload` listener blocks reload while any image is dirty.
- Per-image caches (`originalCache`, `pipelineCaches`,
  `previewBlobUrls`) are bounded by a 16-entry LRU. Eviction
  revokes Blob URLs so the underlying Blobs are freed.
  `localEditState` is intentionally uncapped — entries are tiny
  JSON and evicting a dirty entry would silently lose unsaved work.

### Bake invalidation contract

- `POST /admin/sidecar/:id/ops` snapshots `cache/img/<id>.*` filenames,
  writes the new sidecar, then unlinks the bake AND the snapshotted
  cache files. Snapshotting before the write avoids racing a
  render-in-flight that's about to rename its tmp into final position
  with the new ops.
- `POST /admin/sidecar/:id/bake` writes the new bake atomically (tmp +
  rename), then unlinks `cache/img/<id>.*` so re-bakes don't serve
  stale derivative content.
- A render request landing between `/ops` (bake gone) and the next
  `/bake` (new bake lands) falls through to the original + applyOp
  path. One slower request at most; correct content.

### Magic-byte validation

`POST /admin/sidecar/:id/bake` checks the body starts with `RIFF????WEBP`
before writing. Cheap defense at the boundary against arbitrary
bytes labeled as `image/webp`. Body is capped at 25 MB
(`BAKE_MAX_BYTES`); WebP at q=0.95 for a 50 MP source is ~5–10 MB so
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

Both compete for jobs by atomic SQLite state transitions:

```sql
UPDATE jobs SET state = 'running', updated_at = ?
 WHERE id = ? AND state = 'queued'
RETURNING id;
```

If `RETURNING` returns no row, another worker took the job; move on.

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

```apache
<VirtualHost *:443>
    DocumentRoot /var/www/site

    RewriteEngine On
    RewriteCond %{DOCUMENT_ROOT}/cache%{REQUEST_URI} -f
    RewriteRule ^/img/(.*)$ /cache/img/$1 [L]

    ProxyPreserveHost On
    ProxyPass        / http://127.0.0.1:3000/ enablereuse=on
    ProxyPassReverse / http://127.0.0.1:3000/

    <LocationMatch "^/(cache|static)/">
        Header set Cache-Control "public, max-age=31536000, immutable"
    </LocationMatch>
</VirtualHost>
```

Required modules: `rewrite`, `proxy`, `proxy_http`, `headers`,
`expires`. `immutable` is honest because cache filenames are
content-hashed.

## 8. Editor browser bundle

`tsconfig.browser.json` covers `src/admin/**`, `src/site/**`, and the
two shared lib files the admin bundle pulls in (`prose-markdown.ts` +
`safe-url.ts`). The admin bundle is built with esbuild (TipTap +
ProseMirror + Cropper.js):

- `static/admin/main.js` — admin SPA bundle (~420 KB minified)
- `static/admin/main.css` — Cropper.js extracted CSS
- `static/site/lightbox.js` — public-page lightbox
- `static/site/carousel.js` — public-page carousel runtime

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

```bash
# system deps
apt install nodejs apache2
a2enmod rewrite proxy proxy_http headers expires
a2ensite rkroll
systemctl reload apache2

# app
git clone <repo> /opt/rkr-blog
cd /opt/rkr-blog
npm ci
SITE_ROOT=/var/www/site bin/site-admin init
cp deploy/systemd.service /etc/systemd/system/rkroll.service
systemctl enable --now rkroll
```

Sharp on Debian/Ubuntu uses prebuilt binaries. On Void or musl-based
distros, fall back to `xbps-install vips vips-devel && npm install
--build-from-source sharp`. Production VPS is glibc, so `node_modules`
should not be shipped between dev and prod — install on target.

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
- [x] Google Drive: Picker API + `drive.file` scope; OAuth tokens stored encrypted.
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
- [x] `POST /admin/sidecar/:id/bake` accepts `image/webp` (≤25 MB) and stores `bakes/<id>.webp`. `renderDerivative` prefers it.
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
- [x] `src/site/sw.ts` event-listener glue + `src/site/sw-core.ts`
      pure cache/route logic. Three caches:
      `rkr-shell-v<hash>`, `rkr-pages-v<hash>`, `rkr-images-v<hash>`.
- [x] Cache-first for `/img/*`, SWR for `/static/*` + page navs;
      `Cache-Control: no-store` opt-out for session-private bodies.
- [x] `src/site/sw-register.ts` registers + listens for the
      `rkr-pages-flush` postMessage from login/logout.
- [x] Bake-ops-hash server guard (`X-Rkr-Bake-Ops-Hash`); 409 on
      mismatch; client re-bakes + retries.
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

## 12. Open decisions

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

## 13. Sample fixtures

`test/fixtures/posts/2026-05-06-first-post.md`, sample sidecars, and
small JPEG/PNG images (under 100 KB each, varied aspect ratios, one
with embedded EXIF orientation) live in `test/fixtures/`. They're
committed and used by the test suite.
