# Review findings — mediation plan (2026-08-30)

> **For agentic workers:** REQUIRED: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement task-by-task. Each phase leaves the repo green (`npm run typecheck && npm run lint && npm run knip:gate && npm run circular && npm test`). Work on branch `chore/review-findings-2026-08-30`.

**Goal:** Clear the 2026-08-30 review findings (commit 33b77b5). Most are already tracked in `DEFERRED.md`; the review added three new build-hygiene items (knip entries, `--write` flag, 500-line pressure) and re-prioritised the rest. `docs/backlog.md` is the derived checklist (checked off as items ship, deleted on completion). This plan is the execution order.

**Source:** `docs/backlog.md` (8 groups, ~40 items). Canonical deferred detail stays in `DEFERRED.md` with `_revisit when:` triggers — this plan only orders the work.

**Tech stack:** Node 22, TypeScript strict, Fastify 5, `node:sqlite`, Sharp, esbuild, Biome, knip, dpdm, `node:test` + c8, Playwright. No new deps.

**Conventions:** One commit per task, commit message ends with the repo's `Co-Authored-By` trailer, delete the corresponding `DEFERRED.md` line in the same commit, check the `backlog.md` box.

---

## Phase 0 — Build hygiene (quick wins, no spec)

Unblocks the hook and removes confusion. No behavioural change.

### Task 0.1: knip entry cleanup

**Files:** `package.json` (`knip` field)
- Remove 9 redundant entries flagged by `knip:gate`: `.claude/**`, `.claire/**`, `src/admin/opfs-worker.ts`, `scripts/gen-precache.ts`, `test/playwright.config.ts`, plus the `packages/image-edit` and `apps/image-pwa` workspace entries that duplicate defaults.
- Verify: `npm run knip:gate` → 0 hints.

### Task 0.2: `check-bundle-size --write`

**Files:** `scripts/check-bundle-size.ts`, `scripts/bundle-size-baseline.json` (if updated)
- Parse `process.argv` for `--write`; on overage with flag, rewrite baseline and exit 0; without flag keep current fail behaviour. Update the error message to match the implemented flag.
- Verify: `node scripts/check-bundle-size.ts --write` on a synthetic overage rewrites baseline; without flag still fails.

### Task 0.3: 500-line cap pre-split

**Files:** `src/routes/public.ts` (485), `src/routes/admin.ts` (473), `src/routes/auth.ts` (461), `src/lib/archive.ts` (500)
- Split `public.ts` into `public-index.ts` / `public-post.ts` / `public-search.ts` (or at minimum extract `GET /search`); split `admin.ts` into `admin-upload.ts` vs `admin-posts.ts` core. Keep `archive.ts` under cap by extracting helpers to `archive-helpers.ts`. No route semantics change.
- Verify: `wc -l src/routes/*.ts src/lib/archive*.ts` all <500; `npm run typecheck && npm test` pass.

---

## Phase 1 — Security hardening (single-author safe, but cheapest to fix now)

### Task 1.1: PKCE verifier server-side

**Files:** `src/routes/integrations-gdrive.ts`, `src/routes/integrations-onedrive.ts`, `src/lib/auth-middleware.ts` (reference)
- Mirror `auth.ts#pendingFlows` Map pattern: store `code_verifier` + `state` server-side keyed by a short-lived cookie, bind `state` to `userId`. Drop the JSON cookie payload.
- Test: `test/routes/integrations-*.test.ts` — verifier not in `set-cookie`, state replay without matching user fails.

### Task 1.2: SSRF per-hop re-validation

**Files:** `src/lib/url-safety.ts`, `src/lib/google-drive.ts`, `src/lib/microsoft-graph.ts`, `src/lib/wp-push.ts`
- On redirect, re-run the same allowlist / private-IP check per hop (cap hops, e.g. 5). Reuse `url-safety.ts` helper.
- Test: unit test that a redirect to `http://169.254.169.254` is rejected.

### Task 1.3: CSRF `publicOnlyOrigins` audit

**Files:** `src/lib/csrf.ts`, `test/lib/csrf.test.ts`
- Confirm `isAdminPath` matches Fastify's normalized route (not raw URL) — add test for `/Admin//settings`, `/admin%2Fsettings`, case variants. If mismatch, normalise via `request.routeOptions.url` fallback.
- Test: `publicOnly` origin can POST `/search` but 403 on `/admin/posts`.

### Task 1.4: Roles — record the decision

**Files:** `docs/DEFERRED.md`, `docs/backlog.md`
- If not enforcing now, add a `requireOwner` stub + one test that it 401s when `role !== 'owner'` and mark the `DEFERRED.md` item as `revisit when: second editor invited` with the stub location. No route wired yet — avoids scope creep while making the next step trivial.

---

## Phase 2 — Data integrity + video completion (highest user-visible value)

### Task 2.1: Video sidecars into OPFS bundle

**Files:** `src/routes/admin-post-bundle.ts`, `src/admin/pin.ts`, `src/admin/video-map-opfs.ts`, `test/routes/admin-post-bundle.test.ts`
- Include `sidecars/videos/*.json` in the bundle response; `pin.ts` persists them to OPFS; `buildVideoMapFromOpfs` reads them. Fixes `<!-- missing video -->` in `/admin/view/:slug`.
- E2E: video post renders in preview after pin.

### Task 2.2: Video GC + prewarm

**Files:** `src/cli/gc.ts`, `src/cli/video.ts`, `src/routes/admin-prewarm.ts`
- Mirror image GC over `originals/videos` + `sidecars/videos`; extend `admin-prewarm.ts` to enqueue video derivatives on post save.
- Test: GC deletes orphaned video masters/sidecars; prewarm test asserts 202 not returned for trimmed video on first GET.

### Task 2.3: Slug-rename comment preservation

**Files:** `src/lib/post-index.ts`, `test/lib/post-index.test.ts`
- In the reindex path, update `posts.slug` before file rename is observed (or add a `slug` column update that survives the orphan-delete check). Add test: rename file + change slug, comments retained.

### Task 2.4: GC orphaned originals (images)

**Files:** `src/cli/gc.ts`, `test/cli/gc.test.ts`
- Cross-reference `originals/<aa>/<bb>/*` against all sidecars; delete unreferenced masters (dry-run flag, then actual). Idempotent.

### Task 2.5: Video toolbar button (if scope allows)

**Files:** `src/admin/toolbar.ts`, `src/admin/video-node.ts`
- Add insert-video button + drop handler that calls `POST /admin/upload/video` and inserts a `::video` node. Gated on `video` feature; if deferred, leave the `DEFERRED.md` line with a clear trigger.

---

## Phase 3 — Editor, sync & PWA

### Task 3.1: Double-cached `admin/main.js` + `main.css`

**Files:** `scripts/gen-precache.ts`, `src/templates/admin.ts`
- Deduplicate: either stamp via `?v=` everywhere and serve bare via redirect, or emit precache entries only for `?v=`-stamped URLs and teach chunk loader to request stamped. Measure: `sumDir('static/admin')` before/after.
- Verify: bundle-size baseline updated, precache ~475 KB smaller.

### Task 3.2: Prepass equivalence — variant fidelity

**Files:** `test/lib/image-map-equivalence.test.ts`, `src/lib/image-map-fs.ts`, `src/admin/image-map-opfs.ts`
- Stop stripping `<source>` before compare; instead normalise URLs and compare `srcset` entries per variant. Catches WebP/AVIF divergence.

### Task 3.3: Blob URL revocation + `scanPostForImageIds` dedup

**Files:** `src/admin/image-map-opfs.ts`, `src/lib/posts.ts`, `src/lib/id-resolve.ts`
- Revoke blob URLs on map rebuild (track in a Set, revoke on next build). Replace `posts.ts` prefix logic with `id-resolve.ts` helper.
- Small, safe — combine into one commit.

### Task 3.4: Sync edge cases

**Files:** `src/admin/sync.ts`, `src/admin/draft.ts`, `src/routes/admin.ts` (drain routes)
- `forceConflictedSave`: send `x-rkr-last-synced-at` from OPFS; stale-bundle drain: build-hash check at drain time in `/admin/posts`, `/admin/upload`, `/admin/sidecar/:id/commit` (changes sync contract — document in `implementation.md`).

### Task 3.5: PWA — scope + icons, tilt, canvas coverage

**Files:** `apps/image-pwa/static/*`, `apps/image-pwa/src/sw.ts`, `packages/image-edit/src/core/*` (tilt), `packages/image-edit/src/canvas/*`
- Emit `sw.js` at served root and add icons once `org-hooks` `eof-ws` allows binaries (or gate behind `TEST_SIZE_CAP` exempt). Track tilt as dedicated op instead of delta. Gate canvas layer into c8 or document the e2e ratchet baseline.

---

## Phase 4 — Reliability, polish & tests

### Task 4.1: Flaky e2e fixes

**Files:** `test/e2e/editor-*.spec.ts`
- `offline ops bake drains`: wait for `ensureLocalState` / network idle before save-btn disabled assert.
- `rotate then save`: drain-wait before `loadOriginal`.
- `online-save 409`: increase `waitForResponse` timeout.
- Verify: 10× `npm run test:e2e` green locally and in CI.

### Task 4.2: Structured logging + singletons

**Files:** `src/lib/image-map-fs.ts`, `src/lib/jobs.ts`, `src/lib/config.ts`
- `console.warn` → `app.log.warn`; note `liveInflight` / `events` singletons as process-singletons in `implementation.md` if not refactored. No multi-process change now.

### Task 4.3: WP import + website

**Files:** `src/lib/wp-dump.ts`, `src/lib/wp-import.ts`, `website/index.html`, `deploy/apache.conf`
- `convertDump`: temp file + rename on success (partial `.db` fix).
- `push` tags: forward `tagNames` to `/admin/posts`.
- WP permalinks: `GET /:y/:m/:d/:slug` 301 to `/:slug` when published.
- Website: add CTA when app entry exists; drop `index.html` fallback for non-SPA vhost (return 404).

---

## Verification per phase

After each phase: `npm run typecheck && npm run lint && npm run knip:gate && npm run circular && npm test` and, if `src/admin/**` or `src/site/**` touched, `npm run build:packages && npm run build:admin && npm run build:site && npm run test:e2e`. Update `bundle-size-baseline.json` and `coverage-baseline.json` only on green.

## Sequencing rationale

Phase 0 first — zero risk, unblocks the hook. Phase 1 next — security cheapest while files are small. Phase 2 next — video OPFS and GC are the only user-visible deferred bugs; they share the bundle/GC code paths. Phase 3 — editor/sync/PWA are larger and can land independently. Phase 4 — flaky tests and polish are lowest priority and should follow the code they cover.

## Out of scope (stays in DEFERRED.md until triggered)

Per-instance crops, container directive, cross-figure move, per-process scaling ceiling, infra rate-limit / multi-tenant gaps — each has a `_revisit when:` in `DEFERRED.md`. This plan does not pull them in.
