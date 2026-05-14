# rkr-blog — Offline implementation plan

> **Status as of 2026-05-13: shipped.** Phases 0–3 have all landed
> on `main`. This file is preserved as the historical plan that
> guided the work; the as-built feature list lives in
> `implementation.md` §11 Steps 13–15 (PWA shell + SW, OPFS outbox
> + drain, pin existing posts + eviction). Specific checkboxes
> below remain accurate as a per-task ledger. New offline work
> should extend implementation.md, not this file.

Execution order for `spec-offline.md` plus the spec.md §7 bake-ops-hash
guard. Each phase ends at a commit-able, e2e-green checkpoint. Land
the phase; pause for sign-off; move on.

## Phase 0 — v1 correctness + PWA shell (no offline auth yet)

0a. **Bake-ops-hash server-side** (spec.md §7).
    - `POST /admin/sidecar/:id/bake` reads `X-Rkr-Bake-Ops-Hash` and
      compares to `sha256(canonicalJson(sidecar.ops))`. Mismatch → 409.
    - Missing header → 409 (with explanatory `error: "header required"`).
    - Unit test: two concurrent /bake POSTs, one with stale hash,
      assert 409 + sidecar untouched.

0b. **Bake-ops-hash client-side**.
    - `src/admin/canvas-loaders.ts:uploadBake` accepts ops + computes
      the header. `src/admin/image-edit.ts:saveImageEdits` passes ops
      through.
    - On 409 from /bake: re-fetch ops, re-bake, retry once.
    - e2e: existing rotate-and-save spec exercises the path; no
      regression, header is now sent.

0c. **PWA manifest + icons**.
    - `public/manifest.webmanifest` (per spec-offline §9).
    - 192/512 PNG icons (placeholder solid-color squares are fine
      for v1; real branding later).
    - `<link rel="manifest">` in `src/templates/layout.ts` + `post.ts`.

0d. **Service worker (public side only)**.
    - `src/site/sw.ts`, built to `static/site/sw.js`. Thin
      event-listener glue: install / activate / fetch / message
      delegate to handlers in `src/site/sw-core.ts`.
    - `src/site/sw-core.ts` is the pure logic — cache strategies
      (cache-first for `/img/*`, SWR for `/static/*` and pages),
      LRU caps, and cross-origin / admin / `/_debug/` pass-through.
      Handlers take an injectable `CacheStorageLike` (structural
      interface so the module typechecks under both `tsconfig.json`
      and `tsconfig.browser.json`) and are unit-tested in Node via
      `test/site/sw-core.test.ts` with a Map-backed mock cache.
      Playwright cannot instrument the SW thread, so the unit suite
      is the substitute; see TESTING.md §10 for the
      `check-e2e-coverage.ts` EXEMPT carve-out.
    - Three caches: `rkr-shell-v<hash>`, `rkr-pages-v<hash>`,
      `rkr-images-v<hash>`. Strategy per spec-offline §9.
    - Registered from `src/templates/layout.ts` (public pages only;
      not from `admin.ts`).
    - Install prompt: deferred-prompt pattern; show "Install" link
      in the site footer when `beforeinstallprompt` fires.

0e. **Content-hashed bundles** (so SW invalidation works on deploy).
    - esbuild `--entry-names=[name].[hash]` for `build:admin` and
      `build:site`.
    - HTML templates read the hash from a build-emitted manifest
      (esbuild's `--metafile` → small JSON the templates import).
    - Pre-commit + e2e green.

0f. **Documentation**.
    - Update `developer-quickstart.md` with the bundle-hashing
      gotcha + service-worker registration note.
    - Close the bake-ops-hash entry in DEFERRED.md.

**Phase 0 checkpoint**: PWA installable, public site works offline,
SW invalidates on deploy, bake-hash drift is impossible. No admin
offline yet.

## Phase 1 — OPFS layer + outbox + new-post-offline

1a. **OPFS abstraction** (`src/admin/opfs.ts`).
    - `getRoot(): Promise<FileSystemDirectoryHandle>`
    - `readJson<T>(path): Promise<T | null>`
    - `writeJson(path, data): Promise<void>`
    - `writeBlob(path, blob): Promise<void>` / `readBlob(path)`
    - `listDir(path)`, `removeFile(path)`, `removeDir(path)`
    - `isSupported(): boolean` (feature-detect)
    - Unit-tested via OPFS polyfill in node:test (or stub).

1b. **Schema versioning** (`src/admin/opfs-schema.ts`).
    - `OPFS_SCHEMA_CURRENT = 1`
    - Migration registry (chain of from→to functions).
    - `_root.json` shape + read/init.
    - Atomic version-bump per spec-offline §10.

1c. **Outbox model** (`src/admin/outbox.ts`).
    - Append + drain primitives (per-entry JSON + optional blob).
    - Globally monotonic seq stored in `_root.json`.
    - Coalesce-on-append for `savePost`/`setOps` (latest wins per
      slug/id within not-yet-drained queue).

1d. **Leader election + drain** (`src/admin/sync.ts`).
    - `navigator.locks.request('rkr-sync-leader', ...)` for the
      drain loop.
    - BroadcastChannel('rkr-sync') publishes drain status.
    - 5xx backoff per spec-offline §5.2.
    - 4xx halts; surfaces conflict to user.

1e. **Online detection** (`src/admin/online-state.ts`).
    - `navigator.onLine` + 5s HEAD probe to `/health`.
    - State machine: online / verifying / offline.
    - Wired to BroadcastChannel so all tabs share state.

1f. **Outbox integration: uploadImage + saveImageEdits**.
    - `src/admin/upload.ts:uploadImage` writes blob to OPFS first,
      enqueues `upload` outbox entry.
    - `src/admin/image-edit.ts:saveImageEdits` enqueues `setOps` +
      `bake` outbox entries.

1g. **Outbox integration: handleSave**.
    - `src/admin/save.ts:handleSave` enqueues `savePost`.
    - Sends `X-Rkr-Last-Synced-At` from `meta/<draftId>.json`.
    - On 409: surface conflict UI (discard / force).

1h. **Draft persistence** (`src/admin/draft.ts`).
    - 500ms-debounced writes of TipTap doc to `drafts/<draftId>.json`.
    - Lock heartbeat (`drafts/<draftId>.lock`) every 30s.
    - On editor mount, restore draft from OPFS if present.

1i. **Image-state persistence**.
    - Persist `LocalEditState` to `image-state/<id>.json` after each
      mutation (already mostly in-memory; add OPFS writes).

1j. **Status indicator UI**.
    - Bottom-right badge per spec-offline §8 contract.
    - Click opens placeholder storage panel (filled out in phase 3).

1k. **Server-side: X-Rkr-Last-Synced-At handling**.
    - `POST /admin/posts` checks header against post's `updated_at`.
    - 409 with shape per spec-offline §6.
    - `posts.updated_at` already exists in the table; just compare.

1l. **e2e**.
    - "new post offline → reconnect → drained" flow.
    - "savePost conflict → force-overwrite" flow.

**Phase 1 checkpoint**: author can compose new posts and image edits
offline; on reconnect everything drains; conflicts surface with
discard/force choice.

## Phase 2 — pin existing posts for offline edit

2a. **Server: /admin/post-bundle/:slug?manifest=1** (`src/routes/admin-post-bundle.ts`).
    - Returns JSON manifest per spec-offline §6.
    - Bearer + cookie auth.
    - 404 for unknown slugs.

2b. **Client: bundle pull** (`src/admin/pin.ts`).
    - Fetch manifest, write markdown + sidecars to OPFS.
    - Iterate originals: skip-if-already-cached, fetch via existing
      `GET /admin/original/:id`, write to `originals/<id>.<ext>`.
    - Per-image progress.

2c. **Pin button + UI**.
    - Toolbar button toggles `meta/<draftId>.mode` ↔ pinned/cached.
    - Pinning fetches the bundle if not present.
    - Visual state in toolbar.

2d. **e2e**.
    - "Pin existing post → go offline → edit → reconnect → drained"
      flow.

**Phase 2 checkpoint**: author can pin a post on a desktop, take a
phone offline, edit, reconnect, sync.

## Phase 3 — eviction + storage panel

3a. **Eviction policy** (`src/admin/eviction.ts`).
    - Runs on editor mount + after-drain-empty.
    - Cached posts > 7 days (without lock) evicted.
    - Reference-counted original reclamation per spec-offline §7.

3b. **Storage panel UI** (`src/admin/storage-panel.ts`).
    - Contract from spec-offline §8 (usage, pinned list, cached list,
      pending sync, sync-now / evict-all triggers).
    - Wired to status badge click.

3c. **e2e**.
    - "Cached post evicted after TTL".
    - "Sync now flushes outbox immediately".

**Phase 3 checkpoint**: storage is bounded and visible; nothing leaks
indefinitely; operator has manual controls.

---

## Cross-phase notes

- Each phase ends at a green test:coverage + green e2e. No phase
  ships partially.
- main.ts is at the 500-line cap. New admin code lands in NEW
  modules (opfs.ts, outbox.ts, sync.ts, draft.ts, pin.ts,
  eviction.ts, storage-panel.ts, online-state.ts) and main.ts only
  gains thin wiring calls. Where wiring would push main.ts over the
  cap, extract per the DEFERRED entry "main.ts is exactly at the
  500-line size cap" (refactor to `mountX(deps)` per-panel shape).
- Each new module gets unit tests covered by c8 (since `src/admin/`
  is excluded, the pure-logic pieces move to `src/lib/` per the
  pattern already established for canvas-math, figure-ids,
  image-edit-ops).
- E2e suite gets a new spec per phase. Estimated final size: 12-15
  e2e specs (currently 7).
