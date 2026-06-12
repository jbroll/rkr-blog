# Design: `image-pwa` — standalone upload → edit → download PWA

**Date:** 2026-06-12
**Status:** Approved (brainstorm), pending implementation plan

## Goal

A second, standalone PWA that lets a user upload an image, edit it with the
same tools as the blog admin editor (crop, rotate, arbitrary-angle tilt,
horizontal/vertical flip, perspective rectify, resample), and download the
result. No server, no auth, no blob store, no blog dependency.

Achieved by **extracting the existing image-edit code into a shared workspace
package** that both the blog and the new PWA consume — single source of truth,
so ongoing ops-model work (flip-cancel, rotation-combine, tilt, perspective)
benefits both.

## Decisions (settled during brainstorm)

| Decision | Choice |
|----------|--------|
| Code sharing | Extract a shared library (`packages/image-edit`) |
| Package shape | **One** package, **two** subpath exports (`.` core, `./canvas` browser) |
| Feature scope | **Full parity** with the blog editor |
| Download output | **Format picker**: PNG (lossless) / WebP (quality) / JPEG (quality) |
| Images at once | **Single** image (open, edit, download, repeat) |
| Repo layout | **npm workspaces** (`packages/*`, `apps/*`) |
| org-hooks coverage | **Match siblings**: new code covered by tsc + knip + biome; dup-types / no-reexports / circular stay `src`-scoped (documented gap) |

## Why a workspace package (and why npm `workspaces` specifically)

The sibling repo `wicketmap` runs a `packages/` monorepo with org-hooks but
**does not** use the npm `workspaces` field — it drives everything from root
fan-out scripts and tsconfig project references, because its shared package is
a frontend bundled by Vite and never imported by the Node backend at runtime.

Our case differs in one decisive way: **the rkr-blog server runs TypeScript
directly** (`node --experimental-strip-types bin/server.js`, `moduleResolution:
nodenext`, no compile step) and **already consumes the shared core modules at
runtime** — `ops-validation`, `sidecar-types`, `image-constants` are imported
by `src/routes/admin-sidecar-edit.ts`, `src/routes/public-img.ts`,
`src/routes/sidecar-base.ts`, `src/widgets/figure.ts`, `src/templates/*`.

For the server to `import … from '@rkr/image-edit'` at runtime, Node needs a
real `node_modules/@rkr/image-edit` — which only the npm-workspace symlink
provides. tsconfig `paths` do **not** affect Node's runtime resolution. So npm
workspaces is required here, not merely cleaner.

### Server consumes built JS, not raw `.ts`

Node's `--experimental-strip-types` declines to strip types from code under
`node_modules` (where the workspace symlink lives). Therefore the package
**emits built `.js` + `.d.ts`** via `tsc`, and `exports` points at the built
output. The browser apps (admin, image-pwa) bundle via esbuild, which resolves
either source or built output fine. A new `build:packages` step runs ahead of
the server tests / e2e in the gauntlet.

## Architecture

```
rkr-blog/                          # npm workspaces: ["packages/*", "apps/*"]
  package.json                     # + workspaces field; root fan-out scripts
  lefthook.yml                     # unchanged shape; local block made ws-aware
  knip.json (or package.json knip) # → workspaces map: ., packages/*, apps/*

  packages/image-edit/
    package.json                   # name "@rkr/image-edit", exports map, build script
    tsconfig.json                  # type-check (noEmit)
    tsconfig.build.json            # emits dist/ + .d.ts
    src/
      core/                        # ISOMORPHIC — server + both browser apps
        sidecar-types.ts
        ops-validation.ts
        image-edit-ops.ts
        canvas-math.ts
        rotation.ts
        image-constants.ts
        index.ts                   # re-export surface for "."
      canvas/                      # BROWSER-ONLY — admin + image-pwa
        canvas.ts                  # op pipeline (crop/rotate/flip/resample/perspective)
        canvas-loaders.ts          # REFACTORED: injectable BlobSource (see below)
        cropper-modal.ts
        perspective-modal.ts
        ingest-resize-client.ts    # EXIF-bake + long-edge clamp + encode
        index.ts                   # re-export surface for "./canvas"
    dist/                          # built output (gitignored)

  apps/image-pwa/
    package.json                   # name "@rkr/image-pwa"
    tsconfig.json
    src/
      main.ts                      # bootstrap; file input; MemoryEditState
      memory-edit-state.ts         # in-memory replacement for admin/image-edit.ts
      toolbar.ts                   # full-parity controls + tilt slider
      download.ts                  # format picker + canvas.toBlob + filename
      sw.ts                        # minimal install-only service worker
    index.html
    manifest.webmanifest
    static/                        # icons

  src/                             # blog; imports rewritten to the package:
                                   #   server/admin → @rkr/image-edit
                                   #   admin browser → @rkr/image-edit/canvas
```

### `exports` map (single package, two entry points)

```jsonc
{
  "name": "@rkr/image-edit",
  "type": "module",
  "exports": {
    ".":        { "types": "./dist/core/index.d.ts",   "default": "./dist/core/index.js" },
    "./canvas": { "types": "./dist/canvas/index.d.ts", "default": "./dist/canvas/index.js" }
  },
  "scripts": { "build": "tsc -p tsconfig.build.json" }
}
```

The server imports only `@rkr/image-edit` (core, no DOM). Browser apps import
both. This keeps DOM types out of the server's resolution graph.

## The one real refactor: `canvas-loaders.ts`

Currently hardcodes the blog's data path:

```ts
import { readLocalOriginal } from './local-thumb';   // OPFS
const res = await fetch(`/admin/original/${id}`);     // server endpoint
```

Refactor to an injected source so the module is environment-agnostic:

```ts
export interface BlobSource {
  // resolve an id to the original image bytes
  load(id: string): Promise<Blob>;
}
```

- **blog** injects a `BlobSource` wrapping the existing server-fetch + OPFS
  fallback (behavior unchanged — the fetch/OPFS code moves into the blog's
  adapter, out of the shared package).
- **image-pwa** injects a trivial `BlobSource` backed by the `File` from the
  file input.

Everything downstream (`canvas.ts`, both modals, the pipeline cache) is
untouched. This is the only module whose internals change; the rest move
verbatim.

### What stays in the blog (NOT moved to the package)

`src/admin/image-edit.ts`, `upload.ts`, `outbox.ts`, `sync.ts`, `opfs*.ts`,
`online-state.ts`, `image-edit-panel.ts`, `main.ts` (TipTap). These are
blog/server-sync specific. The blog's `image-edit-panel.ts` keeps driving the
admin UI; it now imports the op logic from `@rkr/image-edit` and the canvas
helpers from `@rkr/image-edit/canvas`, and supplies its own `BlobSource`.

## image-pwa data flow

```
file input / drag-drop
  → ingest-resize-client (EXIF bake, long-edge clamp, decode)
  → MemoryEditState (ops: SidecarOp[], redoStack, source dims) over image-edit-ops
  → canvas pipeline → preview <img src> (blob URL)
  → toolbar ops: crop · rotate90 · tilt-slider · flipH · flipV · perspective · resize
       (undo / redo via image-edit-ops)
  → Download: format picker (PNG | WebP+quality | JPEG+quality)
       → canvas.toBlob(type, quality) → anchor download "<name>-edited.<ext>"
```

No server, no OPFS, no outbox. State is plain in-memory; a page reload starts
fresh (acceptable for a single-image tool). `MemoryEditState` is ~50 lines: it
holds `LocalEditState`, calls the pure mutators (`appendRotate`, `appendFlip`,
`localUndo`, …), and triggers a preview refresh — the in-memory analogue of the
blog's `image-edit.ts` minus all server/OPFS/cross-tab machinery.

## Components — apps/image-pwa

| File | Responsibility |
|------|----------------|
| `main.ts` | Bootstrap, file input + drag-drop, owns a `MemoryEditState`, wires the PWA `BlobSource` (File-backed) |
| `memory-edit-state.ts` | In-memory edit state over `@rkr/image-edit` mutators; preview refresh |
| `toolbar.ts` | Full-parity controls + tilt slider; opens cropper / perspective modals (ported from `image-edit-panel.ts`, minus save/sync) |
| `download.ts` | Format-picker UI; `canvas.toBlob(type, quality)`; filename derivation |
| `sw.ts` | Minimal install-only service worker (same pattern as `src/site/sw-admin.ts`) |
| `index.html`, `manifest.webmanifest`, `static/` icons | PWA shell |

New esbuild target `build:image-pwa` (mirrors `build:admin`):
`esbuild apps/image-pwa/src/main.ts --bundle --splitting --format=esm
--target=es2022 --outdir=apps/image-pwa/dist --minify --sourcemap` plus the SW.

## org-hooks integration (mirrors wicketmap, preserves rkr-blog's bespoke checks)

rkr-blog **keeps its current `lefthook.yml` shape** — remote org-hooks profiles
(`lefthook-common`, `ts`, `sci`, `coverage` at `ref: v0.6.9`) **plus its local
pre-commit block** (the SCI e2e dispatch, e2e coverage ratchet, and bundle-size
ratchet are rkr-blog-specific and must be preserved; the zero-override
`sci-tiered.yml` would drop them, so we do not migrate to it).

We make the gauntlet workspace-aware the way the siblings do — at the root:

1. **Root fan-out type-check.** Extend `type-check` / `typecheck` with
   `&& tsc -p packages/image-edit/tsconfig.json && tsc -p apps/image-pwa/tsconfig.json`.
   The org `ts-typecheck` hook calls `npm run type-check`, so this is what
   actually type-checks the new dirs.
2. **Knip workspaces map.** Convert the `package.json` `knip` field (or a new
   `knip.json`) to a `workspaces` map with entries for `.`,
   `packages/image-edit`, and `apps/image-pwa`, each declaring its own entry
   points. Root `knip:gate` then covers dead code across the workspace.
3. **biome** already globs by extension (`*.{ts,tsx,…}`), so it lints the new
   paths with no change.
4. **Local-block globs.** Where the local commands scope to
   `src/{admin,site}/**`, add `apps/image-pwa/**` (and `packages/**` for the
   parts that should see it) so coverage/build commands include the new app.
5. **Build ordering.** Add `build:packages` (runs each package's `build`) and
   run it before the server tests, admin build, and e2e — the server and the
   esbuild bundles depend on `packages/image-edit/dist`.
6. **Per-package configs only.** Each of `packages/image-edit` and
   `apps/image-pwa` gets its own `package.json` + `tsconfig.json`. **No**
   per-package `lefthook.yml` or knip config — root-driven, per the sibling
   convention.

### Documented coverage gap (accepted)

The org-hooks `ts.yml` checks `check-duplicate-types.mjs src`,
`check-no-reexports.mjs src`, and dpdm `src/**` are hardcoded to `src/` and
**will not scan `packages/` or `apps/`** — exactly as in wicketmap. The new
package/app are instead covered by **tsc + knip + biome**. We deliberately do
**not** modify the shared org-hooks repo (blast radius across all sibling
repos). This gap is accepted and recorded here.

## Coverage / test-runner notes

- `test:coverage` currently `--include='src/**/*.ts' --exclude='src/admin/**'`.
  The moved **core** logic (previously `src/lib/*`, server-tested) must remain
  covered: point the relevant test/coverage globs at `packages/image-edit/src`
  (or its `dist`), and move the existing pure-logic tests with their modules.
- Existing tests that move: `test/lib/canvas-math.test.ts`,
  `test/lib/image-edit-ops.test.ts` (and any ops-validation tests) → into
  `packages/image-edit`. The admin e2e `editor-*.spec.ts` stay with the blog
  (they exercise the blog's server-backed flow) and must keep passing after the
  import rewrite.

## Testing strategy

- **Pure-logic unit tests** move into `packages/image-edit` unchanged and keep
  their thresholds.
- **New PWA workflow test** (headless, per the `workflow-integration` skill):
  load a fixture image → apply a known op sequence → assert output blob
  dimensions / that a non-empty blob is produced for each format. Exercises the
  real package code without a browser.
- **New PWA e2e smoke** (Playwright): upload a fixture → rotate + crop →
  Download → assert a file is saved with the chosen extension.
- **Blog regression**: the existing admin editor e2e must still pass after the
  extraction + import rewrite (proves the refactor preserved behavior).

## Build / scope summary

The PWA itself is small. The bulk of the work — and the risk — is the
**workspace extraction**: moving the shared modules, rewriting server + admin
imports repo-wide to `@rkr/image-edit[/canvas]`, wiring the package build into
the pipeline, and keeping the **full lefthook gauntlet green** (tsc fan-out,
knip workspaces map, coverage globs, bundle-size ratchet) on the commit that
moves everything. This is larger than "a day"; the user has accepted the larger
scope.

## Risks / things to verify during implementation

1. **`tsc -p tsconfig.build.json` dual-entry emit** for `core` + `canvas` with
   correct `.d.ts` and `exports` resolution — spike first; it gates everything.
2. **Server runtime import of built core JS** under the workspace symlink —
   confirm `node --experimental-strip-types bin/server.js` resolves
   `@rkr/image-edit` to `dist/core/index.js` (not `.ts`). Spike with one moved
   module before moving all.
3. **knip false positives** after the move — the workspaces map must declare
   every real entry point or knip will flag live code as dead and fail the
   gauntlet.
4. **Bundle-size ratchet** — import-path churn must not inflate the admin/site
   bundles; the ratchet allows ≤10% growth per commit.
5. **CLAUDE.md staleness (separate cleanup, out of scope here):** the
   "Repo-specific" bullet still describes the removed `.githooks/pre-commit`
   gauntlet; it should point at `lefthook.yml`. Noted, not done in this spec.

## Out of scope

- Batch / multi-image editing.
- Server-side rendering or any blob persistence for the PWA.
- Migrating rkr-blog to `sci-tiered.yml`.
- Modifying the shared org-hooks repo.
