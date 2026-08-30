# Backlog — review findings 2026-08-30

Source: full codebase review at `main` 33b77b5. Every item below was either flagged by the review or already in `DEFERRED.md` and re-surfaced. Grouped by area, ordered by urgency inside each group. Check off when shipped; delete the line. For one-line deferred format with revisit triggers see `DEFERRED.md`.

## 0. Build hygiene — quick wins (no spec needed)

- [x] **knip: remove 9 redundant entry patterns** — `.claude/**`, `.claire/**`, `src/admin/opfs-worker.ts`, `scripts/gen-precache.ts`, `test/playwright.config.ts`, `packages/image-edit` and `apps/image-pwa` entries in `package.json#knip`. Gate passes but hints confuse contributors.
- [x] **`check-bundle-size.ts --write` not implemented** — error message tells caller to re-run with `--write` but `argv` is never parsed. Implement the flag or drop the hint. (`DEFERRED.md: Performance`)
- [ ] **500-line cap pressure** — `src/lib/archive.ts` 500, `src/routes/public.ts` 485, `src/routes/admin.ts` 473, `src/routes/auth.ts` 461. Next feature will trip the hook. Split `public.ts` (index/search/post) and `admin.ts` (upload vs posts) pre-emptively.

## 1. Security

- [ ] **Roles stored but never enforced** — `owner`/`editor` on `users` but no route checks `role`. Single-author safe; inviting an `editor` currently grants full admin. (`DEFERRED.md: Security`)
- [ ] **Provider media fetches follow redirects without per-hop SSRF re-validation** — `url-safety.ts` guards initial URL only. Trusted-author model today. (`DEFERRED.md: Security`)
- [ ] **Integration OAuth PKCE verifier in browser cookie** — gdrive + onedrive store `code_verifier` in JSON cookie; `state` not bound to `userId`. Auth flow already server-side (`auth.ts#pendingFlows`). Mirror that pattern. (`DEFERRED.md: Security`)
- [ ] **Multi-tenant deployability gaps** — no infra rate-limit (only in-process `@fastify/rate-limit`), in-process PKCE state, no auth-write logging. (`DEFERRED.md: Security`)
- [ ] **CSRF `publicOnlyOrigins` + `isAdminPath` edge** — `src/lib/csrf.ts:82` lowercases + collapses slashes; verify against Fastify's normalized `request.url` vs raw URL so `/Admin//settings` cannot bypass `publicOnly` confinement. Audit + add test.

## 2. Data integrity & image pipeline

- [ ] **Slug rename + comment orphan cascade** — renaming `.md` file and changing `slug` frontmatter simultaneously triggers orphan-delete and `CASCADE` deletes comments. Fix: update slug column first (reindex) then rename file. (`DEFERRED.md: Security`)
- [ ] **GC never reclaims orphaned originals** — `src/cli/gc.ts` prunes cache only; `originals/<aa>/<bb>/<id>.<ext>` accumulates forever. Add cross-referencing pass over sidecars. (`DEFERRED.md: Performance`)
- [ ] **Prepass-equivalence test doesn't cover variant fidelity** — `test/lib/image-map-equivalence.test.ts` strips `<source>` before compare; WebP/AVIF divergence invisible. (`DEFERRED.md: Image pipeline`)
- [ ] **`buildImageMapFromOpfs` blob: URLs never revoked** — bounded to one map per load today; re-rendering preview would leak. (`DEFERRED.md: Image pipeline`)
- [ ] **`scanPostForImageIds` duplicates prefix resolution** — third copy of `id-resolve.ts` rule in `src/lib/posts.ts`. Unify on next touch. (`DEFERRED.md: Image pipeline`)
- [ ] **`console.warn` vs structured log** — `src/lib/image-map-fs.ts` uses `console.warn` for bake recreation; should be `app.log.warn`.

## 3. Video (isolated v1 follow-ups)

- [ ] **Video sidecars not synced to OPFS** — `admin-post-bundle.ts` ships only image sidecars; `video-map-opfs.ts` empty, `/admin/view/:slug` shows `<!-- missing video -->`. Wire video sidecars into bundle + `pin.ts`. (`DEFERRED.md: Video`) — highest user-visible deferred.
- [ ] **No admin toolbar button to insert video** — authors use hook/API or raw `::video` markdown today. Add toolbar + drop handler. (`DEFERRED.md: Video`)
- [ ] **`video gc` not implemented** — `bin/site-admin video probe` ships; orphaned video GC does not. Mirror image GC over `originals/videos` + `sidecars/videos`. (`DEFERRED.md: Video`)
- [ ] **Video derivatives not prewarmed on post save** — `admin-prewarm.ts` walks image refs only; trimmed video hits 202+retry on first read. (`DEFERRED.md: Video`)

## 4. Editor, offline sync & PWA

- [ ] **`admin/main.js` + `main.css` double-cached (bare and `?v=`)** — ~475 KB duplicate in precache from `scripts/gen-precache.ts` relative imports vs shell stamping. (`DEFERRED.md: Local-first`)
- [ ] **`forceConflictedSave` re-POST sends no `x-rkr-last-synced-at`** — concurrent other-device edit between conflict and force can be overwritten. (`DEFERRED.md: Local-first`)
- [ ] **Offline-launched client can drain stale bundle to newer server** — network-first narrows window; fix is build-hash check at drain time in `/admin/posts`, `/admin/upload`, `/admin/sidecar/:id/commit`. (`DEFERRED.md: Local-first`)
- [ ] **parseHTML doesn't recover attrs** — rendered-HTML/clipboard round-trip drops figure attrs. (`DEFERRED.md: Editor`)
- [ ] **Per-instance crops in multi-image directives** — crops per-sidecar globally; same image cannot be cropped differently in two posts. (`DEFERRED.md: Editor`)
- [ ] **Container directive for galleries, cross-figure image move** — leaf `::figure` can't carry per-image captions; drag between figures needs two-node PM transaction. (`DEFERRED.md: Editor` — 2 items)
- [ ] **Tilt slider delta-from-last semantics** — `appendRotate(newVal - prevVal)` diverges from absolute after 90° buttons. Track dedicated tilt op. (`DEFERRED.md: image-pwa`)
- [ ] **Package canvas layer not c8-gated** — `packages/image-edit/src/canvas/**` excluded like `src/admin`; only `src/core` gated. (`DEFERRED.md: image-pwa`)
- [ ] **PWA installability (SW scope + icons)** — `sw.js` scope is `dist/`, manifest has no icons due to `eof-ws` hook rejecting PNGs. (`DEFERRED.md: image-pwa`)

## 5. WordPress import & deployment

- [ ] **Legacy WordPress permalinks 404** — `/%year%/%monthnum%/%day%/%postname%/` → `/:slug` without redirect; ~47 in-content links broken. Add `GET /:y/:m/:d/:slug` 301. (`DEFERRED.md: Deployment`)
- [ ] **Push drops resolved tags** — `import-wp push` doesn't forward tag names to `/admin/posts`. (`DEFERRED.md: WordPress import`)
- [ ] **`_binary`/`0x` hex literals stored as text** — dump converter writes blob literals verbatim into TEXT. (`DEFERRED.md: WordPress import`)
- [ ] **Failed conversion leaves partial `.db`** — `convertDump` writes in place. Fix: temp + rename. (`DEFERRED.md: WordPress import`)
- [ ] **Website: no app CTA, unknown paths 200 not 404** — `website/` fallbacks to `index.html` for missing paths. (`DEFERRED.md: Website` — 2 items)

## 6. Performance / reliability

- [ ] **Module-level mutable singletons** — `liveInflight` + `events` in `jobs.ts`, theme cache in `config.ts` are process-singletons. (`DEFERRED.md: Performance`)
- [ ] **Per-process scaling ceiling** — `inflightRenders`/`renderSemaphore` per-process; `listSidecars`/`listPosts` O(n) scans. (`DEFERRED.md: Performance`)
- [ ] **SW `networkFirst` doesn't fall back on non-200** — only on throw/offline; 5xx during deploy won't degrade to cache. (`DEFERRED.md: Performance`)

## 7. Tests

- [ ] **Flaky: `offline ops bake drains on reconnect`** — save-btn disabled races `ensureLocalState`. (`DEFERRED.md: Test coverage`)
- [ ] **Flaky: `rotate single image then save edits`** — 404 on `loadOriginal` races OPFS drain under CI load. (`DEFERRED.md: Test coverage`)
- [ ] **Flaky: `online-save 409 surfaces conflict`** — mtime-bump + 409 timing-sensitive under CI. (`DEFERRED.md: Test coverage`)
- [ ] **PWA e2e smoke not in CI** — `apps/image-pwa` verified via workflow tests + manual smoke, no Playwright spec. (`DEFERRED.md: image-pwa`)
- [ ] **Uncovered: perspective-rectify, Google OAuth callback, perspective-modal WebGL UI** — math unit-tested, shell uncovered. (`DEFERRED.md: Test coverage` — 2 items)

## 8. UI / UX

- [ ] **Owner / user management UI** — DB/CLI only. (`DEFERRED.md: UI`)
- [ ] **User-facing theme picker** — env/ops only. (`DEFERRED.md: UI`)

---

Verification for every item: `npm run typecheck && npm run lint && npm run knip:gate && npm run circular && npm test` green; add/extend a test that would have caught the bug; update `DEFERRED.md` (delete the line) and this file (check the box) in the same commit.
