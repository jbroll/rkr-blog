# RKRoll CMS — Design Specification

Status: draft, ready for implementation
Audience: implementor (Claude Code or the human developer)
Scope: a self-hosted CMS replacing WordPress for a single-author, photo-heavy site.

This document is the source of truth for v1. Implementation should not introduce dependencies, frameworks, or architectural choices not listed here. If implementation hits a need that seems to require something out-of-scope, stop and revise this spec rather than adding the dependency.

---

## 1. Goals

- Static markdown as the canonical content format, with custom widget blocks for non-prose content (images, galleries).
- Editor UI that never exposes markdown syntax to the user.
- Image pipeline that retains the unmodified original, records transformations declaratively, and serves cached derivatives.
- Import images from local upload, arbitrary URL, Google Drive, OneDrive, and Dropbox.
- Lazy derivative rendering by default; full pre-render available as an explicit CLI operation.
- Single-author auth model. No multi-user features in v1.

## 2. Non-goals

- Plugin/theme marketplace.
- Multi-tenant operation.
- Real-time collaboration.
- WYSIWYG fidelity to a final theme inside the editor (preview is separate).

## 3. What NOT to build (out-of-scope, explicit)

The following are deliberately excluded from v1 to control complexity. Adding any of them requires re-opening the spec.

- **Bundlers** for the runtime (Webpack, Vite, esbuild). Source runs as-is via Node's TypeScript loader (`--experimental-strip-types`); no `dist/` directory, no transpile pipeline. A `tsc` build step may be reconsidered if a future feature (decorators, const enums, downlevel target) needs it.
- **Express, Koa, Hapi**, or any HTTP framework other than Fastify.
- **Redis, BullMQ**, or any external job queue. The jobs table in SQLite is the queue.
- **Any ORM** (Prisma, Drizzle, Sequelize, Knex). Hand-written SQL through the `lib/db.js` wrapper.
- **Webpack, Vite, esbuild**, or any bundler for the admin UI. ProseMirror/TipTap loaded via pinned ESM imports from a vendored copy or a CDN with subresource integrity.
- **React, Vue, Svelte** for public-facing pages. Public output is server-rendered HTML.
- **Docker, Kubernetes**, or containerization in v1. Direct install on the VPS.
- **Cloud storage** (S3, R2). Originals and cache live on local disk.
- **A CDN.** Apache serves cache directly.
- **WebSockets, SSE**, real-time anything.
- **ImageMagick.** Sharp/libvips only.
- **`sqlite3` or `better-sqlite3` npm packages.** Use `node:sqlite` behind the wrapper.

---

## 4. Architecture

```
            ┌───────────────┐
  client ──▶│ Apache (TLS)  │── /img/<hash>.<ophash>.<fmt> ──▶ filesystem (cache/)
            │  reverse      │── /static/* ─────────────────▶ filesystem
            │  proxy        │── everything else ───────────▶ Node (Fastify)
            └───────────────┘                                      │
                                                                   ▼
                                                  ┌────────────────────────────┐
                                                  │ Fastify app                │
                                                  │  - admin UI (TipTap)       │
                                                  │  - render handler          │
                                                  │  - upload + import         │
                                                  │  - in-process job worker   │
                                                  └────────────┬───────────────┘
                                                               │
                                  ┌────────────────────────────┼─────────────────────────┐
                                  ▼                            ▼                         ▼
                         ┌────────────────┐         ┌────────────────────┐    ┌────────────────────┐
                         │ node:sqlite    │         │ filesystem store   │    │ Sharp / libvips    │
                         │ (WAL)          │         │  originals/        │    │ in-process worker  │
                         │  - posts       │         │  sidecars/         │    │ (p-limit by CPU)   │
                         │  - jobs        │         │  cache/            │    │                    │
                         │  - sessions    │         │                    │    │                    │
                         │  - oauth tokens│         │                    │    │                    │
                         └────────────────┘         └────────────────────┘    └────────────────────┘
```

Apache serves cache hits directly from disk. Node is invoked only on cache miss, admin routes, and API endpoints. After first render of a derivative, all subsequent requests for that URL bypass Node entirely.

## 5. Stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node 22 LTS or later | `node:sqlite` available; native fetch; native test runner. |
| HTTP | Fastify 5 | Async-native, low per-request overhead, schema validation. |
| DB | `node:sqlite` (built-in, WAL) behind a thin wrapper | Zero native deps; single-writer model fits. Wrapper normalizes rows (node:sqlite returns null-prototype objects), supplies `transaction()`, and coerces bigint rowids — not for swap-out parity. |
| Image pipeline | Sharp (libvips bindings) | Releases libuv thread pool; AVIF/WebP/EXIF/ICC handling. |
| Markdown | `remark` + `remark-directive` + `remark-frontmatter` | Stable AST; directive syntax for widgets. |
| Editor | TipTap (ProseMirror) | Custom node types map cleanly to widget blocks; serializes to markdown + directive syntax. Loaded via vendored ESM. |
| Auth | argon2id | Standard password hash. |
| Front proxy | Apache 2.4 | mod_rewrite + mod_proxy_http. |
| OS (dev) | Void Linux | User's existing environment. |
| OS (prod) | Debian/Ubuntu VPS | Sharp prebuilt binaries resolve cleanly; libc match. |

Sharp on Void: prebuilt binaries cover glibc and musl on x64/arm64. If prebuild resolution fails, fall back to `xbps-install vips vips-devel && npm install --build-from-source sharp`. Production VPS is glibc, so `node_modules` should not be shipped between dev and prod — install on target.

## 6. Coding conventions

- **Module system**: ES modules (`import`/`export`). `package.json` declares `"type": "module"`.
- **Language**: TypeScript with `strict: true`. Server-side code runs directly via Node 22's `--experimental-strip-types` (no transpile, no `dist/`). Type-checking is a separate step (`tsc --noEmit`). Internal imports use `.ts` extensions (with `allowImportingTsExtensions`) so the on-disk extension matches what's imported.
- **Browser-bound code**: `src/admin/` and the browser-bound exports of `src/widgets/*.ts` (the `editorNode` declarations) are emitted to `static/admin/` via `tsc --emit` against `tsconfig.browser.json`. Apache serves `static/admin/` per §14. No bundler is involved — TipTap and ProseMirror are loaded as vendored ESM per §3, and our emitted modules import them by URL.
- **Lint**: Biome (`@biomejs/biome`), configured to enforce §6 conventions and the `recommended` ruleset, applied to both `.ts` and `.js`. The precommit hook runs `biome check`, `tsc --noEmit`, and `npm test`. Biome is the only linter; no ESLint, no Prettier.
- **Indent**: 2 spaces, no tabs.
- **Semicolons**: yes.
- **Quotes**: single quotes for JS strings, double quotes only when escaping.
- **Async**: prefer `async`/`await` over raw promises. Avoid mixing styles within a function.
- **Errors**: throw `Error` (or subclass) for programmer/operational errors. Return `null` or `undefined` for "not found" lookups. Wrap external I/O in try/catch at function boundaries; let bugs propagate.
- **Filenames**: kebab-case (`render-derivative.js`).
- **Exports**: prefer named exports. Default exports only for CLI entry points and route plugin modules.
- **No top-level side effects** in modules other than CLI entry points and the server entry point. Importing a module never starts work, opens a DB, or hits the filesystem.
- **No global state.** Pass dependencies (DB handle, site root) as arguments or via a constructed app context object.
- **Logging**: `console.log` for the server, `console.error` for errors. Structured logging is a v2 concern.

## 7. Test strategy

- Test runner: `node:test` + `node:assert/strict`. No Jest, no Vitest, no Mocha.
- Tests are TypeScript, live in `test/`, mirroring `src/` layout (`src/lib/render.ts` → `test/lib/render.test.ts`).
- Run with `node --test --experimental-strip-types`.
- Coverage with `node --test --experimental-test-coverage --experimental-strip-types`.
- Each test file is independently runnable and uses fresh fixtures (no shared mutable state).
- Fixture images live in `test/fixtures/images/` (small JPEGs/PNGs, committed to repo).
- A test that needs a temporary directory creates one under `os.tmpdir()` and cleans up in a `t.after()` hook.
- Tests that hit the DB use `:memory:` SQLite, run all migrations on setup.

## 8. Repo layout

```
rkroll-cms/
├── bin/
│   ├── site-admin            # CLI entry point (Node shebang)
│   └── server.js             # Fastify entry point (thin .js launcher)
├── src/
│   ├── lib/
│   │   ├── db.ts             # node:sqlite wrapper
│   │   ├── hash.ts           # canonical-JSON, sha256, cache-key derivation
│   │   ├── sidecar.ts        # read/write/validate sidecars
│   │   ├── render.ts         # renderDerivative + Sharp pipeline
│   │   ├── jobs.ts           # job queue operations
│   │   ├── content.ts        # post markdown read/parse/serialize
│   │   ├── widgets.ts        # widget registry, dispatch
│   │   └── auth.ts           # password, session
│   ├── widgets/
│   │   ├── image.ts
│   │   └── gallery.ts
│   ├── admin/                # admin UI sources (HTML, .ts → static/admin/)
│   ├── templates/            # public-facing templates
│   └── routes/
│       ├── public.ts         # GET /, GET /:slug, GET /img/*
│       ├── admin.ts          # admin SPA + API
│       └── import.ts         # remote import endpoints
├── test/
│   ├── lib/                  # mirrors src/lib (*.test.ts)
│   ├── routes/
│   ├── widgets/
│   └── fixtures/
│       ├── images/
│       └── posts/
├── migrations/
│   ├── 001_initial.sql
│   └── (future migrations)
├── deploy/
│   ├── apache.conf           # vhost template
│   └── systemd.service       # systemd unit for the Fastify process
├── biome.json
├── tsconfig.json             # server-side TS (strict, noEmit, type-strip)
├── tsconfig.browser.json     # admin/widgets browser emit → static/admin/
├── package.json
├── package-lock.json
├── README.md
└── spec.md                   # this document
```

The runtime data tree (`originals/`, `sidecars/`, `cache/`, `content/`, `data/`) is **outside** the repo, configured via env var `SITE_ROOT` (default `/var/www/site`). The repo is portable; the data is not.

## 9. Runtime data layout (deployed)

```
$SITE_ROOT/
  originals/                    # immutable, content-addressed by sha256
    ab/cd/abcd1234ef….jpg
  sidecars/                     # one JSON per logical image
    abcd1234ef….json
  cache/
    img/                        # served directly by Apache
      abcd1234ef….<ophash>.webp
      abcd1234ef….<ophash>.avif
  content/
    posts/
      2026-05-06-slug.md        # canonical post source
  data/
    site.db                     # SQLite
  static/                       # CSS, JS bundles, fonts
```

Properties:
- `originals/` is write-once. Re-importing a byte-identical file is a no-op (hash collision = same file).
- `cache/` is fully derivable from `originals/` + `sidecars/`. Safe to delete in full.
- Backup set: `originals/`, `sidecars/`, `content/`, `data/site.db`. Skip `cache/`.

## 10. Sidecar schema

One JSON file per logical image. The "image" the post references is `(original_id, ops_list)`. The user can edit `ops` after upload; each save mutates the sidecar but never the original.

```json
{
  "version": 1,
  "original": "abcd1234ef56...",
  "source": {
    "kind": "gdrive",
    "fileId": "1XyZ...",
    "fetched": "2026-05-06T14:22:11Z",
    "originalName": "DSC_0142.NEF.jpg"
  },
  "metadata": {
    "width": 6000,
    "height": 4000,
    "format": "jpeg",
    "exif": { "DateTimeOriginal": "...", "Model": "..." }
  },
  "ops": [
    { "type": "crop", "x": 100, "y": 200, "w": 4800, "h": 3200 },
    { "type": "resample", "w": 2400, "fit": "inside" }
  ],
  "outputs": [
    { "format": "webp", "quality": 85 },
    { "format": "avif", "quality": 70 }
  ],
  "variants": [
    { "w": 400 }, { "w": 800 }, { "w": 1600 }
  ]
}
```

Rules:
- `ops` describes geometry on the **original**. `crop` is a box in original coordinates, not chained on the previous op's output. Re-edits never compound rounding error and can be reordered safely.
- `outputs` × `variants` enumerates the derivative set.
- The cache key for a single derivative is `hash(original_id || canonical_json(op_subset_for_variant) || format || quality)`. Stored as `<original_id>.<ophash>.<fmt>`.
- `canonical_json` = stable key order (sort keys recursively), no whitespace, no trailing zeros on numbers, ASCII-only escaping. Required so semantically-identical ops produce identical hashes across nodes.

## 11. Image pipeline

### `renderDerivative` interface

```js
// src/lib/render.js

/**
 * Render one derivative variant from an original + ops.
 * Pure modulo filesystem writes: same args → same output bytes at deterministic path.
 *
 * @param {Object} args
 * @param {string} args.originalId   - sha256 hex of original bytes
 * @param {Array}  args.ops          - canonical ops array applied to the original
 * @param {Object} args.variant      - { w?, h?, fit? } size constraint for this variant
 * @param {Object} args.output       - { format: 'webp'|'avif'|'jpeg', quality: number }
 * @param {string} args.siteRoot     - absolute path to site data tree
 * @returns {Promise<{ path: string, bytes: number, cached: boolean }>}
 */
export async function renderDerivative({ originalId, ops, variant, output, siteRoot })
```

Behavior:
- Computes cache key from `(originalId, ops, variant, output)` via canonical JSON + sha256, truncated to 12 hex chars (`ophash`).
- Output path: `${siteRoot}/cache/img/${originalId}.${ophash}.${format}`.
- If the file already exists, returns `{ cached: true }` without invoking Sharp.
- Otherwise: reads original, applies ops in order via Sharp, writes to a temp file, atomic-renames into place.
- Concurrency: caller controls. Use `sharp.concurrency(1)` per call so libvips threads don't multiply with job concurrency.

### Job worker lifecycle

One worker codepath (`workQueue` in `src/lib/jobs.js`). It runs in two contexts:

1. **Inside the Fastify server.** Started at boot, polls the jobs table on a 250ms tick when idle, woken immediately on new enqueue via in-process `EventEmitter`. Concurrency cap = `os.cpus().length`.
2. **Inside `site-admin render`.** Started when the command runs, exits when the queue is drained. Concurrency cap = `os.cpus().length - 1` so an interactive batch doesn't starve a live server on the same box.

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
2. Fastify route parses `<originalId>.<ophash>.<fmt>` from the filename.
3. Looks up the matching sidecar + variant + output by ophash.
4. Calls `renderDerivative` synchronously with a 2-second wall-clock budget.
5. On success within budget: 200 with the bytes (and Apache picks up subsequent requests from disk).
6. On budget exceeded: enqueues the job, returns 202 + a low-res placeholder, client retries.

The 2s budget is configurable; revisit after measuring on the actual VPS.

## 12. Content model

### Storage

Posts are markdown files in `$SITE_ROOT/content/posts/`, with YAML frontmatter for metadata:

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

Custom widgets use the [CommonMark generic directive](https://talk.commonmark.org/t/generic-directives-plugins-syntax/444) syntax (`::name{attrs}`). Parser: `remark` + `remark-directive`.

### Editor

TipTap with custom node types per widget. The user never sees `::image{...}` — they see an image block with handles for crop, alt text, etc. Serialization to markdown happens on save; deserialization on load. The editor and the renderer share the widget registry so they can't drift.

### Renderer

Markdown → mdast → HTML, with directive nodes dispatched to widget render functions. Templates: plain template literals in v1; revisit Eta if widget rendering becomes complex enough to benefit.

### Image widget

The single-image widget renders `::image{...}` directives. It owns the
declaration of which derivative variants exist (the `variants` table is
the source of truth for both the `<picture>` srcset and `site-admin
render`).

**Directive attributes:**

| attribute | required | purpose |
|---|---|---|
| `id` (or `#<id>` shorthand) | yes | sha256 hex of the original (or 6+ char prefix) |
| `alt` | recommended | screen-reader description; for accessibility |
| `caption` | optional | editorial copy visible to all readers; renders inside `<figcaption>` |
| `position` | optional | one of `default`, `full`, `left`, `right`, `inline`. See below. |

**`alt` vs `caption` are different concerns.** `alt` describes what's
in the image for screen readers and image-loading failures. `caption`
is editorial text shown alongside the image. Authoring tools surface
both fields separately.

**Position values:**

| value | layout |
|---|---|
| `default` (or omitted) | wide centered figure that breaks out of the prose column to the wider content width |
| `full` | edge-to-edge of viewport (full bleed) |
| `left` | float left, prose wraps right; clamped to ≤40% column width on desktop, full-width on mobile |
| `right` | mirror of `left` |
| `inline` | inline with text, baseline-aligned, sized to ~1.5em; caption suppressed |

**HTML output:**

Always wraps in `<figure class="rkr-figure rkr-pos-{position}">` so the
position class has a single host element and CSS can style figure +
figcaption uniformly. The `<picture>` element inside contains one
`<source>` per format with srcset entries for each declared variant
width, plus a JPEG fallback `<img>`. `<figcaption>` is appended only
when `caption` is set.

**Module shape (`src/widgets/image.ts`):**

```ts
export const name = 'image';

// Source of truth for srcset + CLI render.
export const variants = [
  { w: 400,  formats: ['webp', 'avif'] },
  { w: 800,  formats: ['webp', 'avif'] },
  { w: 1600, formats: ['webp', 'avif'] }
];

// Fallback for browsers without picture/srcset.
export const fallback = { w: 1200, format: 'jpeg', quality: 85 };

// Server-side render: directive AST node → HTML string.
export function render(node, ctx): Promise<string>;

// Editor (TipTap) node spec. Imported only by the admin bundle.
export const editorNode;
```

`src/lib/widgets.ts` discovers modules in `src/widgets/`, indexes by
`name`, and exposes `dispatch(directiveName, node, ctx)` to the renderer.

### Future image-display widgets (planned)

| widget | layout | notes |
|---|---|---|
| `gallery` | masonry (variable-height grid via CSS columns) | best for mixed-aspect photo sets |
| `matrix` | uniform grid, fixed thumbs | contact-sheet style |
| `carousel` | one image at a time, swipe/click to advance | narrative sequences |
| `justified` | Flickr-style justified rows (uniform row height, variable widths) | clean default for photo blogs |
| `diptych` / `triptych` | 2 or 3 images side by side | editorial pairs/triples |
| `lightbox` | overlay enlargement on click; pairs with any of the above | universal "tap to enlarge" |

All gallery widgets share the same caption convention as the single-image
widget (per-item `caption` attribute → `<figcaption>` per item). Position
values apply only to single-image widgets — galleries occupy the wide
content column by default.

### Public theme

CSS lives at `static/site.css` (committed source), served at
`/static/site.css` by Apache (production) or `@fastify/static` (dev).
Tokens (`--rkr-*` custom properties) cover color, layout, type, and
shadow; image-display widgets reuse them so look-and-feel stays
consistent across single images, galleries, and lightboxes.

Site branding is configured per deployment via env vars:

| var | default | purpose |
|---|---|---|
| `SITE_TITLE` | `rkroll` | Header title + `<title>` suffix |
| `SITE_TAGLINE` | (none) | Optional subtitle in the site header |

## 13. Remote image import

Use providers' official picker SDKs, not URL parsing.

| Provider | Mechanism | Auth | Notes |
|---|---|---|---|
| Local upload | `<input type="file" multiple>` | session | Streamed to `originals/`, hashed during stream. |
| Plain URL | server-side fetch | none | 50MB cap, content-type allowlist (`image/*`), 30s timeout. |
| Dropbox | Chooser SDK | none for read | Returns direct download link. Implement first. |
| OneDrive | File Picker SDK v8 + Graph | OAuth2 | |
| Google Drive | Picker API + Drive v3 | OAuth2, `drive.file` scope | `drive.file` avoids broad-access verification. |

Common path: picker returns a file handle → server streams bytes to a temp file → sha256 during stream → if hash already in `originals/`, dedupe; otherwise atomic-rename into place → write sidecar with `source.kind` set. Provenance is recorded but the original is treated identically regardless of source.

OAuth tokens stored in SQLite, encrypted at rest with a key from a config file outside the repo (`$SITE_ROOT/data/secret.key`, mode 0600). Refresh on access.

## 14. HTTP layer

### Apache vhost

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

Required modules: `rewrite`, `proxy`, `proxy_http`, `headers`, `expires`. `immutable` is honest because cache filenames are content-hashed.

### Fastify routes

```
GET  /                          → rendered index
GET  /:slug                     → rendered post
GET  /img/:filename             → on miss only; renders + writes to cache
POST /admin/login               → password (argon2id) + session cookie
GET  /admin                     → editor SPA
POST /admin/posts               → create
PUT  /admin/posts/:id           → update
POST /admin/upload              → multipart, streams to originals/
POST /admin/import/url          → server-side fetch
POST /admin/import/dropbox      → accept Chooser payload
POST /admin/import/onedrive     → accept Picker payload + token
POST /admin/import/gdrive       → accept Picker payload + token
POST /admin/sidecar/:id         → update ops/variants on existing image
GET  /health                    → 200 {"ok":true}
```

Routes split into Fastify plugin modules in `src/routes/`. Each module exports a default function `(fastify, opts)` per Fastify convention.

## 15. Database

### `lib/db.js` interface

```js
// src/lib/db.js

/**
 * Open a database. Sets WAL mode and foreign keys on first open.
 */
export function open(path)

// Returned DB:
//   prepare(sql)         → Statement
//   exec(sql)            → void           // multi-statement; no params
//   transaction(fn)      → wrappedFn      // BEGIN/COMMIT/ROLLBACK around fn
//   pragma(name, value)  → result
//   close()              → void

// Statement:
//   run(...params)       → { changes, lastInsertRowid }
//   get(...params)       → row | undefined
//   all(...params)       → row[]
//   iterate(...params)   → AsyncIterator<row>
```

`iterate` yields the result set as an async iterator, but does not stream — it calls `all()` and yields each row. If a real streaming need appears (very large result sets that don't fit in memory), revisit by either swapping the driver or implementing pagination in the caller.

`node:sqlite` requires `--experimental-sqlite` on Node 22 and is unflagged on Node 24+. Server and CLI run with `--no-warnings=ExperimentalWarning` to suppress the stderr notice.

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
  path TEXT NOT NULL                  -- relative path to .md file under content/
);

CREATE INDEX posts_status_published ON posts(status, published_at DESC);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                 -- 'render' for now
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

Auth refactor when social login replaced single-password (spec §17). Drops
the `auth` table and rebuilds `sessions` + `oauth_tokens` to be per-user.

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
  provider TEXT NOT NULL,             -- 'google' (Apple TBD)
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

CREATE TABLE oauth_tokens (                            -- per-user picker tokens
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,             -- 'gdrive','onedrive'
  access_token BLOB NOT NULL,         -- encrypted
  refresh_token BLOB,                 -- encrypted
  expires_at TEXT NOT NULL,
  scope TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);
```

Posts table is an index over the markdown files, not the source of truth. `site-admin reindex` rebuilds it from the filesystem.

### Migration strategy

```
migrations/
  001_initial.sql
  002_add_xyz.sql
```

`site-admin migrate` reads the directory, sorts numerically, applies any version not in `schema_migrations` inside its own transaction. No down-migrations in v1; rollback by restore from backup.

## 16. CLI

`bin/site-admin` is a Node script with shebang `#!/usr/bin/env node`, made available via `package.json` `bin`. Subcommand dispatch in `bin/site-admin` itself; per-command handlers in `src/cli/<name>.js`.

```
site-admin init                           # create $SITE_ROOT layout, run migrations
site-admin migrate                        # run pending migrations
site-admin reindex                        # rebuild posts table from content/
site-admin render                         # all posts, all variants, skip existing
site-admin render --post <slug>
site-admin render --since <iso-date>
site-admin render --force                 # re-render existing
site-admin gc                             # delete orphan cache entries
site-admin verify                         # rehash originals; flag mismatches
site-admin import <url-or-path>           # one-off import outside the editor
site-admin password                       # set admin password
site-admin server [--port 3000]           # run Fastify
```

`render` and `gc` together make lazy-by-default safe long-term:
- `render` warms the cache before traffic (e.g. after a bulk ops change).
- `gc` walks every sidecar, builds the set of valid `<id>.<ophash>.<fmt>` filenames, deletes everything in `cache/` not in the set. Idempotent.

## 17. Auth

- **Social login only.** Sign in via Google (Apple deferred). No passwords stored anywhere; the OAuth provider handles credentials, MFA, recovery.
- **Invite-only allowlist.** A successful Google authorization only creates a user if the email appears in `allowed_emails`. `site-admin user invite <email> [--role owner|editor]` adds entries; same CLI gives `list` and `remove`.
- **Roles:** `owner` (everything) and `editor` (everything except user management). Role is per-user, set at invite time.
- **Sessions:** 32-byte random id, server-side `sessions` row, 30-day expiry, sliding `last_seen_at`. Cookie: `HttpOnly`, `Secure`, `SameSite=Lax`.
- **Per-user tokens for picker integrations** (Google Drive, OneDrive — Step 7c) live in `oauth_tokens` keyed by `(user_id, provider)`, encrypted at rest with `lib/secrets.ts` (AES-256-GCM, key from `$SITE_ROOT/data/secret.key`, mode 0600, generated by `site-admin init` if absent).
- **OAuth library:** [`arctic`](https://arcticjs.dev) — handles authorize-URL building, code-for-token exchange, refresh, and the trickier wire formats (PKCE, ID token decoding). Token storage and session management stay in our own code (no `better-auth`, no ORM).
- **No CSRF protection in v1** — `SameSite=Lax` session cookie, no third-party-initiated state changes. Revisit if any admin route accepts cross-origin requests.
- **Login rate-limit** is delegated to Google; the OAuth callback already required a successful provider-side auth.

Environment variables (per deployment):

```
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
PUBLIC_BASE_URL          # e.g. https://example.com — used to build the OAuth redirect URI
```

## 18. Sample files (commit to repo)

### `test/fixtures/posts/2026-05-06-first-post.md`

```markdown
---
title: First post
slug: first-post
date: 2026-05-06T14:00:00Z
status: published
tags: [intro, photo]
---

This is the opening paragraph. It has **bold** and *emphasis* and a [link](https://example.com).

::image{id=abc123def4567890 alt="A photo of the workbench"}

A second paragraph follows the image, with normal prose flow.

::gallery{ids=[abc123,def456,789abc] layout=masonry}

Closing paragraph.
```

### `test/fixtures/sidecars/abc123def4567890.json`

```json
{
  "version": 1,
  "original": "abc123def4567890abc123def4567890abc123def4567890abc123def4567890",
  "source": {
    "kind": "upload",
    "fetched": "2026-05-06T14:00:00Z",
    "originalName": "DSC_0142.jpg"
  },
  "metadata": {
    "width": 6000,
    "height": 4000,
    "format": "jpeg",
    "exif": { "DateTimeOriginal": "2026-05-04T11:32:08" }
  },
  "ops": [
    { "type": "crop", "x": 100, "y": 200, "w": 4800, "h": 3200 },
    { "type": "resample", "w": 2400, "fit": "inside" }
  ],
  "outputs": [
    { "format": "webp", "quality": 85 },
    { "format": "avif", "quality": 70 }
  ],
  "variants": [
    { "w": 400 }, { "w": 800 }, { "w": 1600 }
  ]
}
```

### `test/fixtures/images/`

A handful of small JPEGs and PNGs (under 100KB each), with varied aspect ratios and one with embedded EXIF orientation, committed to the repo.

## 19. Initial `package.json`

```json
{
  "name": "rkroll-cms",
  "version": "0.1.0",
  "description": "Single-author CMS with photo-first content model.",
  "type": "module",
  "private": true,
  "engines": {
    "node": ">=22.0.0"
  },
  "bin": {
    "site-admin": "./bin/site-admin"
  },
  "scripts": {
    "start": "node --no-warnings=ExperimentalWarning --experimental-strip-types bin/server.js",
    "test": "node --test --no-warnings=ExperimentalWarning --experimental-strip-types",
    "test:coverage": "node --test --experimental-test-coverage --no-warnings=ExperimentalWarning --experimental-strip-types",
    "typecheck": "tsc --noEmit",
    "lint": "biome check",
    "build:admin": "tsc -p tsconfig.browser.json",
    "check": "tsc --noEmit && biome check && npm test",
    "hooks:install": "git config core.hooksPath .githooks",
    "migrate": "node --no-warnings=ExperimentalWarning --experimental-strip-types bin/site-admin migrate",
    "render": "node --no-warnings=ExperimentalWarning --experimental-strip-types bin/site-admin render",
    "gc": "node --no-warnings=ExperimentalWarning --experimental-strip-types bin/site-admin gc"
  },
  "dependencies": {
    "fastify": "^5.0.0",
    "@fastify/multipart": "^9.0.0",
    "@fastify/cookie": "^9.0.0",
    "@fastify/rate-limit": "^10.0.0",
    "@fastify/static": "^9.0.0",
    "sharp": "^0.33.0",
    "remark": "^15.0.0",
    "remark-directive": "^3.0.0",
    "remark-frontmatter": "^5.0.0",
    "yaml": "^2.5.0",
    "arctic": "^3.0.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.0.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0"
  }
}
```

Runtime deps: `fastify` (+ official plugins), `sharp`, the `remark` family, `yaml`, `argon2`. `argon2` is a native module but ships prebuilds; fallback on Void is `crypto.scrypt` from `node:crypto`. Dev deps: TypeScript (type-checking only — `--experimental-strip-types` runs sources directly), Biome (lint/format), `@types/node`. `tsconfig.browser.json` emits `src/admin/` to `static/admin/`.

## 20. Open decisions

These are intentionally not pinned. The implementor may make a call and document it inline in the relevant module.

1. **Markdown directive serializer**: TipTap output → markdown round-trip. `remark-directive` parses; the serializer side may need a small custom plugin. Decide based on what `remark-stringify` produces by default.
2. **Sync vs async render budget on miss**: 2s default is a guess. Measure and tune.
3. **AVIF cost/benefit**: encoding is ~10× slower than WebP. Either accept the publish-time cost (eager render) or restrict AVIF to the on-demand path with a longer wall-clock budget.
4. **Vendoring TipTap**: download a pinned ESM bundle to `src/admin/vendor/` vs CDN with SRI. Lean toward vendoring for offline dev and reproducible installs.

## 21. Build order with acceptance criteria

Each step ends with a binary done-signal. Don't move to step N+1 until step N's signal is green. Each step is roughly one PR.

### Step 1 — Skeleton

- [ ] Repo created with the layout in §8.
- [ ] `package.json` from §19 committed.
- [ ] `lib/db.js` wrapper implemented; opens `:memory:` and a file path; basic round-trip test.
- [ ] `bin/site-admin migrate` runs `001_initial.sql` against `$SITE_ROOT/data/site.db`.
- [ ] `bin/site-admin init` creates `$SITE_ROOT` directory tree if absent, runs migrations.
- [ ] `bin/server.js` starts a Fastify server, `GET /health` returns `200 {"ok":true}`.
- [ ] `node --test` runs and at least one trivial test passes.
- [ ] `deploy/apache.conf` and `deploy/systemd.service` written; not deployed yet.

### Step 2 — Originals + sidecars

- [ ] `lib/hash.js` exports `sha256File`, `sha256Stream`, `canonicalJson`, `cacheKey`. All four covered by tests, including round-trip determinism.
- [ ] `lib/sidecar.js` exports `read(siteRoot, id)`, `write(siteRoot, id, data)`, `validate(data)`. Round-trip tested.
- [ ] `POST /admin/upload` (multipart, no auth gate yet) writes to `originals/<id[0:2]>/<id[2:4]>/<id>.<ext>` (two-level shard, matches §9), computes hash during stream, writes sidecar with `source.kind = 'upload'`. Authoritative format/extension comes from Sharp-detected bytes, not the client's filename. Tested with a fixture image.
- [ ] Re-upload of byte-identical file is detected and dedup'd (same hash, no second write, existing sidecar preserved).

### Step 3 — Render pipeline

- [ ] `lib/render.js` `renderDerivative` produces deterministic output: same inputs → same bytes (verified by hashing output in test).
- [ ] Cache hit: a second call with identical args returns `{cached: true}` without invoking Sharp (verified by spying on Sharp).
- [ ] Cache key changes when ops change (cropping a different region produces a different filename).
- [ ] `lib/jobs.js` enqueue/dequeue/complete operations covered by tests, including atomic-claim race (two workers can't claim the same job — simulated with parallel `UPDATE … RETURNING`).
- [ ] `GET /img/<filename>` on cache miss enqueues + renders + serves; on hit, the route is bypassed entirely by Apache (verified by request log absence in dev).

### Step 4 — CLI render and gc

- [ ] `site-admin render` walks all sidecars, enqueues all declared variants, runs them to completion. Tested against a 3-post fixture set.
- [ ] `site-admin render --force` re-renders existing.
- [ ] `site-admin render --post <slug>` renders only that post's images.
- [ ] `site-admin gc` deletes orphan cache entries; idempotent (run twice, second is a no-op).
- [ ] `site-admin verify` rehashes originals; flags any mismatch.

### Step 5 — Markdown rendering (no editor yet)

- [ ] `lib/content.js` parses post `.md` files (frontmatter + body + directives) and serializes back. Round-trip on the fixture post is byte-identical (or differs only in whitespace normalization, documented).
- [ ] `lib/widgets.js` registry; image widget renders to `<picture>` with srcset matching the variants in the widget definition.
- [ ] `GET /:slug` returns rendered HTML for the fixture post.
- [ ] `GET /` returns a paginated index.
- [ ] `site-admin reindex` populates the posts table from `content/posts/`.

### Step 6 — TipTap editor

- [ ] TipTap vendored in `src/admin/vendor/`.
- [ ] Admin SPA loads at `/admin/editor`.
- [ ] Image block: upload, displays a preview, edits alt text, crop UI, saves a post that round-trips through markdown.
- [ ] No markdown syntax visible in the editor at any point.

### Step 7 — Remote import

- [ ] Dropbox first: `POST /admin/import/dropbox` accepts a Chooser payload, server-side fetches the file, writes original + sidecar with `source.kind = 'dropbox'`.
- [ ] OneDrive after Dropbox: same shape, OAuth tokens stored encrypted in `oauth_tokens`.
- [ ] Google Drive last: `drive.file` scope.
- [ ] Plain URL import: `POST /admin/import/url`, with size cap and content-type allowlist enforced.

### Step 8 — Gallery widget

- [ ] Multi-image widget with masonry layout. Renders to a static gallery on the public side; in the editor, supports add/remove/reorder.

### Step 9 — Auth

- [ ] `site-admin password` sets argon2id hash in the `auth` table.
- [ ] `POST /admin/login` issues session cookie; rate-limited.
- [ ] All `/admin/*` routes (except login) require valid session.
- [ ] `POST /admin/upload` from step 2 is now gated.

### Step 10 — Public theme

- [ ] CSS, fonts, header/footer, post template, index template.
- [ ] No JS on the public side except native `loading="lazy"` on images.
- [ ] Mobile-responsive.
- [ ] Apache vhost deployed to a staging VPS; full smoke test (publish a post, view as anonymous user, check `<picture>` srcset, verify cache headers).

---

## Appendix A — Environment variables

| Var | Default | Purpose |
|---|---|---|
| `SITE_ROOT` | `/var/www/site` | Root of runtime data tree. |
| `PORT` | `3000` | Fastify listen port. |
| `HOST` | `127.0.0.1` | Fastify listen interface (Apache reverse-proxies). |
| `SESSION_SECRET` | (required) | Cookie signing. Read from `$SITE_ROOT/data/secret.key`. |
| `LOG_LEVEL` | `info` | `info`, `warn`, `error`. |

## Appendix B — Reference commands

Initial setup on a fresh VPS:

```bash
# system deps
apt install nodejs apache2
a2enmod rewrite proxy proxy_http headers expires
a2ensite rkroll
systemctl reload apache2

# app
git clone <repo> /opt/rkroll-cms
cd /opt/rkroll-cms
npm ci
SITE_ROOT=/var/www/site bin/site-admin init
SITE_ROOT=/var/www/site bin/site-admin password
cp deploy/systemd.service /etc/systemd/system/rkroll.service
systemctl enable --now rkroll
```

Initial setup on Void for development:

```bash
xbps-install -S nodejs
git clone <repo> ~/src/rkroll-cms
cd ~/src/rkroll-cms
npm ci   # if Sharp prebuild fails: xbps-install vips vips-devel && npm install --build-from-source sharp
SITE_ROOT=$HOME/site bin/site-admin init
SITE_ROOT=$HOME/site npm start
```
