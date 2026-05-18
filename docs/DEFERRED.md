# Deferred items

Known work we've deliberately not done yet. One line each, grouped by
area, with the condition that should pull it back into the queue.
Delete an item when it ships; promote it (move up, add detail) if it
gets worse than expected. Fuller rationale for any item lives in the
git history of this file and the commit/spec that introduced it.

Format: **item** — _revisit when:_ trigger.

## Security

- **Multi-tenant deployability gaps** — no infra rate-limit (only
  in-process `@fastify/rate-limit`), in-process PKCE state, no
  auth-write logging. _Revisit when:_ any shared/team/multi-tenant
  pivot.
- **Provider media fetches follow redirects without per-hop SSRF re-validation** — trusted single-author model; `url-safety.ts` guards the initial URL only. _Revisit when:_ opening authoring to untrusted/multi-author posters.

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

## Local-first / sync

- **`forceConflictedSave` re-POST sends no `x-rkr-last-synced-at`** — a concurrent other-device edit between the conflict and the force can be overwritten (explicit user action; server idempotency covers replays, not this). _Revisit when:_ multi-device editing becomes common.

## UI / UX

- **Owner / user management UI** — users/sessions are DB/CLI only.
  _Revisit when:_ first co-author or multi-user pivot.
- **User-facing theme picker** — theme is an env/ops action only.
  _Revisit when:_ author wants >1 theme live or per-post override.

## Performance / reliability

- **Replace placeholder admin PWA icons** — `static/admin-manifest.webmanifest` reuses the public `icon-192.png` / `icon-512.png`. _Revisit when:_ an editor-specific icon is designed.
- **Module-level mutable singletons** — `liveInflight` + `events` emitter in `src/lib/jobs.ts`, resolved-theme cache in `config.ts` are process-singletons (fine for single-instance deploy). _Revisit when:_ moving to multi-process/multi-instance.
- **Per-process scaling ceiling** — `inflightRenders`/`renderSemaphore` are per-process; `listSidecars`/`listPosts` do O(n) full-scans per call. _Revisit when:_ horizontal scaling or corpus grows to thousands.
- **SW `networkFirst` (admin bundle) doesn't fall back to cache on non-200** — only on thrown/offline error; a deploy momentarily 5xx-ing won't degrade to cached copy (deliberate, mirrors `cacheFirst`). _Revisit when:_ admin-bundle deploy resilience matters.


## Test coverage

- **Playwright: perspective-rectify + Google OAuth callback** —
  _revisit when:_ fixture infra grows, or a UI bug ships uncaught.
- **e2e-uncovered: perspective-modal WebGL UI** — math is now
  unit-tested; only the WebGL shell is uncovered. _Revisit when:_ a
  stable headless WebGL path or a Canvas2D fallback exists.
