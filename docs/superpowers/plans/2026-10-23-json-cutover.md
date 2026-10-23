# JSON Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every public page renders from JSON block trees and every edit happens in the blocks editor; markdown becomes an unread archive.

**Architecture:** Teach the post index to read `content/blocks/*.json` alongside markdown (matched by slug so comment threads survive), switch public reads to JSON-first with markdown fallback, then retire the legacy editor and markdown write paths and archive the `.md` files out of the read path.

**Tech Stack:** TypeScript (Node >=22), existing post-index SQLite schema unchanged, existing render pipeline for leaves.

**Spec:** `docs/superpowers/specs/2026-10-22-reusable-blocks-design.md` (JSON-pages rev 2 + editor interaction updates, same directory)

## Global Constraints

- Work happens on `exp/reusable-blocks`; each task ends green (`typecheck`, `lint`, `knip:gate`, touched tests) and committed.
- Node >=22.0.0; no new runtime dependencies.
- Slugs are stable across the cutover: comment threads, legacy permalinks, and `/pages/:slug` URLs must not break.
- Markdown files are moved, never deleted, until the final task verifies parity.
- Staging verification against `/tmp/opencode/rkr-blocks-bulk` (65 posts) after reader-facing tasks.

## Review Focus

- A JSON page whose `fields.slug` collides with a markdown slug renders once, never twice, and keeps the markdown post's comments.
- A corrupt JSON twin degrades to its markdown source instead of 500ing.
- A brand-new JSON page with no markdown twin is searchable and listed.
- Deleting the last twin of a slug removes it from the index without orphaning its comments to the wrong post.
- The legacy editor URL answers 404 or redirect after retirement, never a half-working editor.

---

### Task 1: JSON-aware post index

**Files:**
- Modify: `src/lib/post-index.ts`
- Test: `test/lib/post-index-blocks.test.ts` (new; existing `test/lib/post-index.test.ts` must stay green)

**Model:** `sonnet` — index semantics need judgment.

**Interfaces:**
- Consumes: `parseBlockTree` from `src/lib/blocks.ts`, `listBlockPages`-style scan of `content/blocks`.
- Produces: `runReindex` indexing both sources; existing `readIndexed*` helpers unchanged in signature.

- [ ] **Step 1: Write the failing test**

```ts
// test/lib/post-index-blocks.test.ts
test('reindex pairs a JSON twin with its markdown post by slug', () => {
  // write 2026-01-15-hello.md + hello.json, runReindex, expect one row, JSON wins title
});
test('reindex indexes a JSON-only page as published when fields.status is published', () => {
  // write only blocks/solo.json, expect one row with its title and tags
});
test('reindex skips a corrupt JSON twin and keeps the markdown row', () => {
  // write bad.json + good.md with same slug, expect the markdown title
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types --conditions=development test/lib/post-index-blocks.test.ts`
Expected: FAIL (JSON files ignored today)

- [ ] **Step 3: Implement JSON pairing in `runReindex` in `src/lib/post-index.ts`**

Scan `content/blocks/*.json` alongside markdown; match twins by `fields.slug`; JSON fields win for title/date/status/tags; plain text for FTS comes from `text` leaves in document order; post-row identity (and therefore comment threads) follows the markdown row when paired, new row for JSON-only pages.

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2
Expected: PASS (new tests) plus `test/lib/post-index.test.ts` still PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/post-index.ts test/lib/post-index-blocks.test.ts
git commit -m "feat: index JSON twins alongside markdown posts"
```

### Task 2: Public reads render JSON-first

**Files:**
- Modify: `src/routes/public.ts` (GET `/`, GET `/:slug`)
- Test: extend `test/routes/blocks.test.ts` or `test/routes/public-pages.test.ts` with twin fixtures

**Model:** `sonnet` — render-path branching with fallback.

**Interfaces:**
- Consumes: unified index from Task 1; `readBlockPage` from `src/lib/block-pages.ts`; `renderBlockTree` from `src/lib/blocks-render.ts`.
- Produces: `/` and `/:slug` HTML identical in shape to today, sourced from JSON when a twin exists.

- [ ] **Step 1: Write the failing test**

```ts
test('GET /:slug renders the JSON twin when one exists', async () => {
  // write md + twin with different body text; expect the JSON text in HTML
});
test('GET /:slug falls back to markdown without a twin', async () => {
  // write md only; expect the markdown text in HTML
});
test('GET / lists JSON-only pages', async () => {
  // write blocks-only page; expect its title in the index HTML
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ... test/routes/public-pages.test.ts`
Expected: FAIL (JSON text absent)

- [ ] **Step 3: Implement JSON-first render in `src/routes/public.ts`**

For the resolved post row, prefer `readBlockPage(siteRoot, slug)`; on null or corrupt twin, render markdown as today. Page title, date, tags, and comments plumbing stay exactly as-is. `list` leaves keep today's placeholder-comment behavior (real listing data is MVP editor Task 3, tracked separately — pages render with card bands missing until then).

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/public.ts test/routes/public-pages.test.ts
git commit -m "feat: render JSON twins on public post pages"
```

### Task 3: Retire the legacy editor and markdown write paths

**Files:**
- Modify: `src/routes/admin.ts`, `src/routes/admin-posts.ts`, `src/routes/admin-post-bundle.ts`, `src/server.ts`
- Delete: `src/templates/admin.ts` editor shell if unreferenced after removal
- Test: update `test/routes/admin*.test.ts`, `test/e2e/*` editor specs that post markdown

**Model:** `opus` — broad-coverage removal with test fallout.

**Interfaces:**
- Consumes: `/admin/blocks`, `/admin/blocks/edit/:slug`, `/admin/blocks/new` (all live).
- Produces: no route that writes `content/posts/*.md`; `/admin/editor` answers 404 with a pointer to `/admin/blocks`.

- [ ] **Step 1: Write the failing test**

```ts
test('legacy markdown write routes are gone', async () => {
  // POST /admin/posts, POST /admin/posts/:slug/delete, GET /admin/post-bundle/:slug → 404
  // GET /admin/editor → 404 with a link to /admin/blocks
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ... test/routes/admin.test.ts`
Expected: FAIL (routes still registered)

- [ ] **Step 3: Remove markdown write routes and the legacy editor shell from `src/routes/admin.ts`, `src/routes/admin-posts.ts`, `src/routes/admin-post-bundle.ts`, `src/server.ts`**

Delete POST save, delete, status-flip, post-bundle pin, and the `/admin/editor` + `/admin/view/:slug` shell; keep read-only admin surfaces (comments moderation, settings, tags). Update or delete the tests that exercised the removed routes instead of leaving them red.

- [ ] **Step 4: Run test to verify it passes**

Run: full `test/routes/*.test.ts` plus `test/templates/*.test.ts`
Expected: PASS, 0 references to removed routes

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: retire legacy markdown editor and write paths"
```

### Task 4: Archive markdown sources out of the read path

**Files:**
- Modify: `src/cli/blocks-migrate.ts` (add `archive` subcommand or flag), `docs/RUNBOOK.md` (operator note)
- Test: `test/cli/blocks-migrate.test.ts` (archive moves files, reindex after archive keeps every slug)

**Model:** `sonnet` — operator tooling judgment.

**Interfaces:**
- Consumes: `runBlocksMigrateAll` (exists).
- Produces: `content/posts/*.md` moved to `content/posts-legacy/*.md`; `runReindex` reads only `content/blocks`.

- [ ] **Step 1: Write the failing test**

```ts
test('archive moves markdown out of the read path', async (t) => {
  // seed md + twin, run archive, expect md gone from content/posts, twin intact, reindex keeps the slug
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ... test/cli/blocks-migrate.test.ts`
Expected: FAIL (no archive command)

- [ ] **Step 3: Implement archive in `src/cli/blocks-migrate.ts`**

Move (not copy, never delete) every `content/posts/*.md` to `content/posts-legacy/`; refuse when a slug has no JSON twin unless `--include-untwinned` is passed; print the moved count.

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/blocks-migrate.ts test/cli/blocks-migrate.test.ts
git commit -m "feat: archive markdown sources after JSON cutover"
```

### Task 5: Cutover verification on staging data

**Files:** none (verification only; record results in this plan file)

**Model:** `haiku` — mechanical checks.

- [ ] **Step 1: Migrate and archive the staging bulk root.** Run `blocks-migrate --all` (expect 65 twins) then archive on a copy of `/tmp/opencode/rkr-blocks-bulk`.
- [ ] **Step 2: Restart staging and check counts.** `/` and `/pages` list 65 slugs each; every slug resolves on both `/:slug` and `/pages/:slug` with identical body text.
- [ ] **Step 3: Check comments continuity.** A test comment on one slug before the cutover still renders after it.
- [ ] **Step 4: Check retired routes.** `/admin/editor`, `POST /admin/posts`, `/admin/post-bundle/:slug` answer 404.
- [ ] **Step 5: Record results.** Append the outcome table to this plan file and commit it.

### Task 6: Whole-branch final review

**Files:** none (review only)

**Model:** `opus` — highest-stakes review, reserved for the end.

- [ ] **Step 1: Diff `main...exp/reusable-blocks` in full.**
- [ ] **Step 2: Verify every spec requirement in `docs/superpowers/specs/2026-10-22-reusable-blocks-design.md` maps to a shipped task.**
- [ ] **Step 3: File findings as follow-ups; block merge on Must-fix items only.**

## Task 5 outcome (2026-10-23, staging copy of /tmp/opencode/rkr-blocks-bulk)

Method: throwaway script driving the real app (`buildApp` + `inject`, no
network) against a fresh tar copy at `/home/john/cutover-verify` (/tmp/tmpfs
too small for a second copy). 15/15 checks green.

| Check | Result |
|---|---|
| Pre-cutover published rows | 66 (65 markdown + 1 JSON-only `stage-note`) |
| `blocks-migrate --all` | 65 twins written |
| `blocks-migrate --archive` | 65 moved to `content/posts-legacy/`; only `_` system files remain |
| Post-cutover indexed slugs | 66, identical set to pre-cutover |
| `/` and `/pages` | list all 66 slugs |
| `/:slug` vs `/pages/:slug` | all 66 resolve 200 with byte-identical post bodies (article chrome excluded: comments/header live only on `/:slug` by design) |
| Comment continuity | published comment added pre-cutover still renders post-cutover |
| Retired routes | `GET /admin/editor`, `POST /admin/posts`, `GET /admin/post-bundle/x?manifest=1` all 404; editor 404 links to `/admin/blocks` |

Notes: corpus slugs are quoted YAML (`slug: "…"`, WordPress importer
style) — exposed a `listPosts` bug that kept the quotes and made the
archive refuse every twin; fixed in `01cf9be` (unquote + regression test).
`/:slug` vs `/pages/:slug` differ in chrome by design (scripts, article
wrapper, comments); bodies are identical.
