# Deferred items

Known work we've deliberately not done yet. One line each, grouped by
area, with the condition that should pull it back into the queue.
Delete an item when it ships; promote it (move up, add detail) if it
gets worse than expected. Fuller rationale for any item lives in the
git history of this file and the commit/spec that introduced it.

Format: **item** — _revisit when:_ trigger.

## Security

- **`/admin/reindex` and post-delete stay on `requireUser`, not `requireOwner`** — `requireOwner` is wired to the credential/config/archive routes and `POST /admin/reset`; reindex and post-delete were deliberately left open to any admin user. _Revisit when:_ second editor invited and these two routes need owner-only treatment too.
- **Multi-tenant deployability gaps** — no infra rate-limit (only
  in-process `@fastify/rate-limit`), in-process PKCE state, no
  auth-write logging. _Revisit when:_ any shared/team/multi-tenant
  pivot.

## Editor & figures

- **parseHTML doesn't recover attrs** (9b) — rendered-HTML/clipboard
  round-trip drops figure attrs. _Revisit when:_ a "duplicate post" /
  "paste from preview" feature lands, or authors lose data via
  clipboard.
- **Per-instance crops in multi-image directives** — crops are
  per-sidecar (global to every post using the image). _Revisit when:_
  an author wants the same image cropped differently in two posts.
- **Container directive form for galleries** — leaf directive can't carry per-image captions. _Revisit when:_ per-image captions inside a multi-image directive are needed.
- **Cross-figure image move** — drag an image from one figure into
  another (two-node PM transaction + emptied-source deletion).
  _Revisit when:_ an author wants an image moved between two figures.

## Image pipeline

- **`buildImageMapFromOpfs` blob: URLs are never revoked** — every URL it makes reaches the rendered document and must outlive it, and the preview renders once per page load, so there is nothing to revoke yet. _Revisit when:_ the preview starts re-rendering without a full page reload.

## UI / UX

- **Owner / user management UI** — users/sessions are DB/CLI only.
  _Revisit when:_ first co-author or multi-user pivot.
- **User-facing theme picker** — theme is an env/ops action only.
  _Revisit when:_ author wants >1 theme live or per-post override.

## Performance / reliability

- **Module-level mutable singletons** — `liveInflight` + `events` emitter in `src/lib/jobs.ts`, resolved-theme cache in `config.ts` are process-singletons (fine for single-instance deploy). _Revisit when:_ moving to multi-process/multi-instance.
- **Per-process scaling ceiling** — `inflightRenders`/`renderSemaphore` are per-process; `listSidecars`/`listPosts` do O(n) full-scans per call. _Revisit when:_ horizontal scaling or corpus grows to thousands.
- **SW `networkFirst` (admin bundle) doesn't fall back to cache on non-200** — only on thrown/offline error; a deploy momentarily 5xx-ing won't degrade to cached copy (deliberate, mirrors `cacheFirst`). _Revisit when:_ admin-bundle deploy resilience matters.
- **`resolveSavedStatus`/`resolveSavedDate` vanish window** (`src/routes/admin-frontmatter.ts:17`, `:32`) — `existsSync` then `readFileSync`; a file deleted in between throws ENOENT. _Revisit when:_ this crash is observed, or the vanish-window class gets fixed elsewhere and this one should match.


## Test coverage

- **Flaky: `editor: per-cell selection drives the image-edit panel for multi-image figures`** — `editor-flow.spec.ts:718` timed out waiting for the rotate status once and passed on retry. _Revisit when:_ it fails twice in a row or fails on a first attempt in CI.
- **Flaky: `about-page.spec.ts:46`** — timed out once during this branch's e2e runs. _Revisit when:_ it fails twice in a row or fails on a first attempt in CI.
- **Playwright: perspective-rectify + Google OAuth callback** —
  _revisit when:_ fixture infra grows, or a UI bug ships uncaught.
- **e2e-uncovered: perspective-modal WebGL UI** — math is now
  unit-tested; only the WebGL shell is uncovered. _Revisit when:_ a
  stable headless WebGL path or a Canvas2D fallback exists.

## Website (marketing site)

- **No app CTA on the landing page** — `website/` ships no "Try it" / sign-up button because the app has no public entry flow. _Revisit when:_ the app gains a public entry/sign-up flow; wire CTAs in `index.html` nav/hero/footer to the app domain.
