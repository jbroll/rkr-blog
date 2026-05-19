# rkr-blog — Developer quickstart

Getting set up to work on the codebase. Coding conventions, lint /
test / hook configuration, command cheatsheet.

For what the application does, see [spec.md](./spec.md).
For how the codebase delivers it, see [implementation.md](./implementation.md).

---

## 1. Prerequisites

- **Node 22 LTS or later.** `node:sqlite` is available behind
  `--experimental-sqlite` on Node 22; unflagged on 24+. The npm scripts
  pass `--no-warnings=ExperimentalWarning` so the stderr notice
  doesn't clutter output.
- **A C toolchain** for native `sharp` builds when prebuilds are
  unavailable (musl distros, ARM variants). Debian / Ubuntu / macOS
  prebuilds resolve cleanly out of the box.

## 2. Initial setup

```bash
git clone <repo> ~/src/rkr-blog
cd ~/src/rkr-blog
npm run setup                # node_modules + chromium + git hooks
SITE_ROOT=$HOME/site bin/site-admin init
```

`npm run setup` runs three idempotent steps via `scripts/setup.sh`:

1. **`npm install`** — pulls every Node dep, including the binary
   ones: `sharp` (libvips bindings; ships prebuilds for
   Debian / Ubuntu / macOS / glibc + ARM), and the dev tooling
   (biome, knip, dpdm, c8, esbuild, tiptap, cropperjs, @playwright/test).
2. **`npx playwright install chromium`** — downloads Chrome Headless
   Shell (~110 MB) into the Playwright cache. Required for
   `npm run test:e2e`. Skipped on second run.
3. **`npm run hooks:install`** — sets `git config core.hooksPath` to
   `.githooks/` so `pre-commit` runs the full gate (biome / tsc /
   duplicate-type / no-reexports / knip / circular-import / size /
   c8 coverage thresholds; plus bundle-size ratchet + e2e + e2e
   coverage ratchet when `src/admin/**` or `src/site/**` is staged).

### Distro-specific Sharp notes

`sharp` ships prebuilds for the common targets, but a few cases need
the OS to provide libvips before `npm install` succeeds:

```bash
# Void Linux (and any musl distro / non-standard ARM)
xbps-install -S nodejs vips vips-devel
# Then either: re-run npm run setup, or force a source build:
npm install --build-from-source sharp
```

If `npm install` fails inside `npm run setup`, drop to `npm install`
manually so the build error is visible, fix the libvips path, then
re-run `npm run setup` to pick up at the playwright + hooks steps.

## 3. Running locally

```bash
SITE_ROOT=$HOME/site PORT=3000 npm start
curl http://127.0.0.1:3000/health      # → {"ok":true}
```

Browse the editor at `http://127.0.0.1:3000/admin/editor`.

### First-time login

There is no implicit "first user becomes owner" bootstrap. Before any
OAuth login can succeed, invite the operator email via the CLI:

```bash
SITE_ROOT=$HOME/site bin/site-admin user invite you@example.com --role=owner
```

Without an entry on the allowlist, every login 403s. This closes the
deployment-window takeover risk where a stranger reaching the URL
before the operator's first login could otherwise become owner. Add
editors the same way (`--role=editor`).

## 4. Coding conventions

### Module system + language

- ES modules (`import`/`export`). `package.json` declares
  `"type": "module"`.
- TypeScript with `strict: true`. Server-side code runs directly via
  Node 22's `--experimental-strip-types` (no transpile, no `dist/`).
  Type-checking is a separate step (`tsc --noEmit`).
- Internal imports use `.ts` extensions
  (`allowImportingTsExtensions`) so the on-disk extension matches what
  the import statement says. Browser code (under `tsconfig.browser.json`)
  uses extensionless imports because esbuild handles resolution.

### Style

- 2-space indent, no tabs.
- Semicolons on.
- Single quotes for JS strings; double quotes only when escaping.
- Prefer `async` / `await` over raw promises. Don't mix styles within
  a function.
- Throw `Error` (or a subclass) for programmer / operational errors.
  Return `null` or `undefined` for "not found" lookups. Wrap external
  I/O in try/catch at function boundaries; let bugs propagate.
- Filenames are kebab-case (`render-derivative.ts`).
- Prefer named exports. Default exports only for CLI entry points and
  Fastify route plugin modules.
- **No top-level side effects** in modules other than CLI entry points
  and `bin/server.js`. Importing a module never starts work, opens a
  DB, or hits the filesystem.
- **No global state.** Pass dependencies (DB handle, site root) as
  arguments or via a constructed app context.
- Logging: `console.log` for the server, `console.error` for errors.
  Structured logging is a v2 concern.

### Comments

- Default to writing no comments. Only add one when the WHY is
  non-obvious — a hidden constraint, a subtle invariant, a workaround
  for a specific bug, behavior that would surprise a reader.
- Don't explain WHAT the code does. Well-named identifiers do that.
- Don't reference the current task, fix, or callers. Those belong in
  the PR description and rot as the codebase evolves.

### Browser code

- `src/admin/` and `src/site/` are the browser bundles. They depend on
  the DOM and live under `tsconfig.browser.json` (`lib: ["dom"]`).
- Pure helpers that the server-side test runner needs to import live
  in DOM-free siblings (e.g. `canvas-math.ts` is testable from
  `test/admin/canvas.test.ts` because it has no DOM imports).

## 5. Lint

Biome (`@biomejs/biome`) is the only linter. No ESLint, no Prettier.
Configured in `biome.json` to enforce the conventions above plus
the `recommended` ruleset, applied to both `.ts` and `.js`.

```bash
npm run lint                 # biome check
npm run lint:fix             # biome check --write
npm run format               # biome format --write
```

The pre-commit hook runs `biome check --staged`.

## 6. Tests

`node:test` + `node:assert/strict`. No Jest, no Vitest, no Mocha.

- Tests are TypeScript, live in `test/`, mirror `src/` layout
  (`src/lib/render.ts` → `test/lib/render.test.ts`).
- Each test file is independently runnable; uses fresh fixtures (no
  shared mutable state).
- Tests that need a temporary directory create one under
  `os.tmpdir()` and clean up in a `t.after()` hook.
- Tests that hit the DB use `:memory:` SQLite, run all migrations on
  setup.
- Fixture images live in `test/fixtures/images/` (small JPEGs and
  PNGs, committed).

```bash
npm test                     # node --test
npm run test:coverage        # c8 with per-file thresholds
                             # (lines=90 / branches=75 / fns=90)
npm run typecheck            # tsc --noEmit (server + browser)
npm run check                # typecheck + lint + test:coverage
npm run test:e2e             # Playwright (chromium, headless)
                             # plus V8 coverage of the admin SPA bundle
                             # via monocart-coverage-reports → coverage/e2e/
npm run test:e2e:headed      # Playwright (chromium, visible)
npm run test:coverage:full   # c8 (server) + e2e (browser) end-to-end;
                             # writes lcov to coverage/ + coverage/e2e/
```

`test:coverage` excludes `src/admin/**` (browser code, requires a DOM
shim to test directly; the pure-math siblings already moved to
`src/lib/` are covered). `test:e2e` fills that gap by capturing V8
coverage of the live admin bundle: every spec wraps `page.coverage.
startJSCoverage()` via the fixture in `test/e2e/coverage-fixtures.ts`,
the global teardown emits an HTML report at `coverage/e2e/index.html`
and lcov at `coverage/e2e/lcov.info`. Source maps map the bundle URLs
back to `src/admin/*.ts` and `src/site/*.ts` so the report is in
source-file space.

`test:e2e` boots the server via `test/e2e/server-runner.ts` against a
freshly-mkdtemp'd SITE_ROOT, runs the spec files in `test/e2e/`, and
tears down. The chromium binary it drives was installed by
`npm run setup`; if `playwright install` was skipped (or the cache
was cleared), re-run `npx playwright install chromium`.

For writing new e2e specs (selector patterns, isolation rules, the
`?e2e=1` debug hook, the per-test PNG-uniqueness gotcha, debugging,
the pre-commit ratchet), see [`TESTING.md`](./TESTING.md).

### Other gates the pre-commit hook runs

Beyond tests, biome, and tsc, the hook (`./.githooks/pre-commit`)
also runs:

```bash
node scripts/check-duplicate-types.ts   # cross-file dupe interfaces / types
node scripts/check-no-reexports.ts      # `export { … } from …` patterns
npm run knip:gate                       # full knip report (dead code)
npm run circular                        # dpdm circular-import survey
```

Each is invokable on demand if you want to debug a specific failure.
The size hook (per-file 500-line ceiling for `src/`/`bin/`; tests
exempt) is inline in the hook itself. When `src/admin/**` or
`src/site/**` files are staged the hook additionally runs:
`build:admin`, `build:site`, the bundle-size ratchet
(`scripts/check-bundle-size.ts`), the full e2e suite, and the e2e
coverage ratchet (`scripts/check-e2e-coverage.ts`).

## 7. Building the admin bundle

```bash
npm run build:admin          # esbuild → static/admin/ (main, posts-list, settings-page)
npm run build:site           # esbuild → static/site/ (lightbox, carousel, img-retry, copy-link, comment-form, sw-unregister, sw-admin, sw-admin-register)
npm run build                # both
```

The pre-commit hook does NOT run the build — you commit source, not
the bundle. Production builds happen at deploy time.

## 8. Command cheatsheet

```bash
# one-shot environment setup (idempotent)
npm run setup                             # npm install + playwright install + hooks

# tests + lint + gates
npm test                                  # node --test (unit)
npm run test:coverage                     # c8 with per-file thresholds
npm run test:e2e                          # Playwright (chromium, headless)
npm run test:e2e:headed                   # Playwright (visible)
npm run lint                              # biome check
npm run lint:fix                          # biome check --write
npm run typecheck                         # tsc --noEmit (server + browser)
npm run knip                              # full dead-code report
npm run knip:gate                         # gate subset (pre-commit step)
npm run circular                          # dpdm circular-import check
npm run check                             # typecheck + lint + test:coverage
npm run hooks:install                     # one-time: enable .githooks/

# server
npm start                                 # boot Fastify
SITE_ROOT=$HOME/site PORT=3000 npm start  # with explicit env

# admin bundle
npm run build:admin                       # esbuild → static/admin/ (main, posts-list, settings-page)
npm run build:site                        # esbuild → static/site/*.js
npm run build                             # both
npm run clean:admin                       # rm -rf static/admin
npm run clean:site                        # rm -rf static/site

# CLI
SITE_ROOT=$HOME/site bin/site-admin init
SITE_ROOT=$HOME/site bin/site-admin migrate
SITE_ROOT=$HOME/site bin/site-admin reindex
SITE_ROOT=$HOME/site bin/site-admin render
SITE_ROOT=$HOME/site bin/site-admin gc
SITE_ROOT=$HOME/site bin/site-admin verify
SITE_ROOT=$HOME/site bin/site-admin reset --to <url> --token <ADMIN_TOKEN> --force
SITE_ROOT=$HOME/site bin/site-admin user invite <email> [--role owner|editor]
SITE_ROOT=$HOME/site bin/site-admin jobs failed
SITE_ROOT=$HOME/site bin/site-admin import-wp push <wp-base> <slug> --to <fly-url>
SITE_ROOT=$HOME/site bin/site-admin server [--port N]
```

For the operator-facing reset → seed → walk procedure (against the Fly
demo or a local dev server), see [`RUNBOOK.md`](RUNBOOK.md).

## 9. On-device browser test page

`src/routes/dev-test.html` is a live in-browser test harness for APIs
that can't be covered by Playwright's headless Chromium — OPFS storage,
WebGL, canvas encoding, and the admin API upload/commit flow. It runs in
real mobile browsers on real devices.

### Starting the server for device testing

```bash
ENABLE_TEST_ROUTES=1 HOST=0.0.0.0 ADMIN_TOKEN=<token> npm start
# or, if secrets.env holds the real credentials:
set -a && . ./secrets.env && set +a
ENABLE_TEST_ROUTES=1 HOST=0.0.0.0 ADMIN_TOKEN=dev-test npm start
```

`ENABLE_TEST_ROUTES=1` enables the `/_test*` routes.  
`HOST=0.0.0.0` binds to all interfaces so phones/tablets on the same
network can reach the server.

### Running on a device

Navigate to `http://<machine-ip>:<port>/_test?admin_token=<ADMIN_TOKEN>`
on the target device. The page runs automatically and posts results to
`/_test/results` (logged to stdout) and emits a final PASS / FAIL status.

The `admin_token` query param is required for levels 7–9 (admin API
tests). Without it those levels are skipped with `⊘ skipped`.

### Live reload

The server watches `src/routes/dev-test.html` and broadcasts a `reload`
SSE event on every save. The test page reconnects and re-runs
automatically. To trigger a reload manually from the terminal:

```bash
curl http://localhost:<port>/_test/reload
```

### What the levels test

| Level | What it exercises |
|-------|-------------------|
| 1 | Raw OPFS APIs: `navigator.storage.getDirectory()`, `createWritable()` on main thread; `createSyncAccessHandle()` in a worker |
| 2 | OPFS worker bundle present (`HEAD /static/admin/opfs-worker.js`) |
| 3 | App's `writeFile` via the worker; read-back via `readFile` |
| 4 | Persistence across a simulated worker restart |
| 5 | Concurrent write race (two workers writing the same path) |
| 6 | 1 MB write + read-back latency |
| 7 | Admin upload: canvas JPEG → `POST /admin/upload`, id round-trip |
| 8 | Crop commit: canvas bake (WebP or JPEG fallback) → `POST /admin/sidecar/:id/commit` |
| 9 | Sidecar meta read-back: ops and dims persisted after commit |
| 10 | Canvas capability matrix (informational — never gates pass/fail): `canvas.toBlob` format support, WebGL renderer/max-texture, `createImageBitmap`, `OffscreenCanvas` |
| 11 | Client-side ingest pipeline: `createImageBitmap` + `OffscreenCanvas.drawImage` + `convertToBlob('image/webp')` end-to-end (mirrors `ingest-resize-client.ts`; detects iOS WebP encode failure) |
| 12 | WebGL rendering: compiles a minimal vert+frag shader, draws a full-screen quad, reads pixels back with `readPixels` to verify GPU output (validates `applyPerspective` preconditions) |
| 13 | `BroadcastChannel` send/receive round-trip (used by `online-state.ts` and `sync.ts` for cross-tab coordination) |
| 14 | `navigator.locks.request()` acquisition and sequential exclusion (used by `opfs-schema.ts` ROOT_LOCK and `sync.ts` drain/sync locks) |
| 15 | Platform APIs matrix (informational): `navigator.storage.estimate()` quota/usage, `serviceWorker` availability, `navigator.onLine`, `clipboard.writeText` permission state |
| 16 | `crypto.randomUUID()` (OPFS message IDs, draft IDs), `TextEncoder`/`TextDecoder` (OPFS worker file encoding) |
| 17 | Blob URL + `HTMLImageElement` decode round-trip: `URL.createObjectURL` → `new Image()` load → `drawImage` → `getImageData` pixel verification (mirrors `canvas-loaders.ts loadOriginal`) |
| 18 | Canvas 2D transform correctness: `applyCrop`, `applyRotate 90°`, `applyFlipH`, `applyFlipV` — all verified with `getImageData` pixel checks (catches Android WebView transform bugs) |

### Adding new levels

1. Write a `async function levelN(…)` that returns an array of result
   objects `{ name, ok, detail }`. `ok: true` = pass, `ok: false` = fail,
   `ok: null` = skip (filtered from the posted results).
2. Call it in `run()` after the preceding level. Gate on `ok === false`
   (not `!ok`) so skipped results don't abort the run.
3. For diagnostic-only levels (like level 10) don't add a gate at all.

The server logs every result JSON to stdout; the SSE client on the page
shows results in real time.

## 9. Troubleshooting

- **Sharp prebuild fails on Void.** Install libvips and rebuild:
  `xbps-install vips vips-devel && npm install --build-from-source sharp`.
- **`node:sqlite` warning on Node 22.** Expected; the npm scripts pass
  `--no-warnings=ExperimentalWarning`. If you invoke Node directly,
  add the same flag.
- **Bundle changed but the editor still shows the old code.** Hard
  refresh (`Ctrl-Shift-R`); the bundle URL doesn't have a cache
  buster.
- **`npm test` fails with `Cannot find module '…/canvas.ts'`.** Make
  sure tests import `.ts` extensions (server tsconfig has
  `allowImportingTsExtensions`).
- **Editor "perspective" button is greyed out.** Browser doesn't
  support WebGL (or has it disabled). The button's tooltip explains
  why; other ops still work.
- **`npm run test:e2e` errors with `Executable doesn't exist at
  …/chrome-linux/headless_shell`.** The chromium binary isn't in the
  Playwright cache. Re-run `npx playwright install chromium`
  (or `npm run setup` to redo the whole bootstrap).
