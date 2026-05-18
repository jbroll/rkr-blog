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

- **`src/admin/main.ts` next size-split unit** — per-cell caption/alt wiring + `spliceCellSlot` gated by deferred per-cell-caption/alt e2e coverage (DEFERRED 9a). _Revisit when:_ DEFERRED 9a (per-cell caption/alt) ships — split alongside its e2e.
- **parseHTML doesn't recover attrs** (9b) — rendered-HTML/clipboard
  round-trip drops figure attrs. _Revisit when:_ a "duplicate post" /
  "paste from preview" feature lands, or authors lose data via
  clipboard.
- **Per-instance crops in multi-image directives** — crops are
  per-sidecar (global to every post using the image). _Revisit when:_
  an author wants the same image cropped differently in two posts.
- **Container directive form for galleries** — leaf `alts="a,b,c"`
  can't carry a comma in any single alt. _Revisit when:_ an alt needs
  a comma, or per-image captions inside a multi-image directive.
- **Friendlier layout/position values** — values are machine strings
  (`1x2`/`bleed`/…); needs a labelled `<select>` + value migration.
  _Revisit when:_ an author finds the values confusing, or any
  figure-panel rework.
- **Advanced disclosure for width/aspect/fit/autoplay** — collapse
  rarely-used figure fields behind a `<details>`. _Revisit when:_ the
  figure panel feels busy or grows more fields.
- **Status pill / visibility chooser** — replace the draft/published
  `<select>` with pills in the editor. _Revisit when:_ a top-form
  layout pass, or status gains a third value.
- **Per-cell active-cell persistence** — selection resets to null when
  leaving and returning to a multi-image figure. _Revisit when:_ first
  author feedback on multi-image editing.
- **Cross-figure image move** — drag an image from one figure into
  another (two-node PM transaction + emptied-source deletion).
  _Revisit when:_ an author wants an image moved between two figures.

## Local-first / sync

- **`forceConflictedSave` re-POST sends no `x-rkr-last-synced-at`** — a concurrent other-device edit between the conflict and the force can be overwritten (explicit user action; server idempotency covers replays, not this). _Revisit when:_ multi-device editing becomes common.
- **HEIC upload: probe-decode → convert or reject** — non-Safari
  browsers can't decode HEIC at all (`createImageBitmap` *and* `<img>`
  both fail), so the elaborate "coord divergence" scenario is largely
  unreachable there; the real defect is the silent raw-upload
  fallback. Fix: capability-probe the upload (try to decode it — not
  UA sniffing). Decodes → the existing client-resize path already
  re-encodes it to WebP/JPEG with client/server coords consistent by
  construction. Doesn't → reject with "export to JPEG/PNG first"
  instead of the silent raw fallback. _Revisit when:_ ready to close
  the raw-HEIC fallback — small, deterministic, ends the divergence
  outright (verify the resize client re-encodes rather than passing
  original bytes when decodable).

## UI / UX

- **"Save & view" combined editor button** — currently a permalink in
  the status line. _Revisit when:_ author friction with the
  save→click pattern.
- **Owner / user management UI** — users/sessions are DB/CLI only.
  _Revisit when:_ first co-author or multi-user pivot.
- **User-facing theme picker** — theme is an env/ops action only.
  _Revisit when:_ author wants >1 theme live or per-post override.
- **Comment bubble floated right in post title** — match the
  roll-along.rkroll.com treatment. _Revisit when:_ next
  comments-UI/post-title work, or explicit go-ahead.

## Performance / reliability

- **Drop public/anon offline; keep authoring offline; make the editor
  installable** — delete the public service worker + page/image cache
  (`src/site/sw.ts` / `sw-core.ts` / `sw-register.ts` ≈285 LOC, the
  `manifest` + `sw-register` refs in index/post/search/404, the
  public-scoped manifest, `test/site/sw-core.test.ts`). Authoring
  offline is OPFS/outbox and SW-independent — **untouched**. Then add
  PWA installability for the **authoring** SPA (currently absent):
  an `/admin`-scoped `manifest` (start_url `/admin/editor`, scope
  `/admin`, icons, `display: standalone`) linked from `admin.ts`;
  decide whether a minimal `/admin` SW is needed for cross-browser
  install or modern manifest-only install suffices (the editor keeps
  working offline via OPFS either way). Closes outright: the
  post-deploy "30s to first page" SW-nav stall, SW
  stale-vs-fresh-comments, and the public-offline indicator. _Revisit
  when:_ ready — a decided simplification; needs a spec/plan.
- **Post-deploy deploy-gate (non-SW half)** — independent of the
  above: `node_app/start.sh` does `systemctl restart` + a blind
  `sleep 2`, no `/health` poll. Minor once the SW stall is gone.
  _Revisit when:_ deploys get frequent enough that the ~1s restart
  window matters, or when touching `deploy.sh`.
- **Teaser top-post sync `fs.readFileSync`** — blocking read on the
  anon `GET /` teaser path (mirrors the `_site-banner.md` read).
  _Revisit when:_ the homepage sees bot/cache-miss traffic, or the
  banner read is converted to async (do both together).
- **Module-level mutable singletons** — `liveInflight` + `events` emitter in `src/lib/jobs.ts`, resolved-theme cache in `config.ts` are process-singletons (fine for single-instance deploy). _Revisit when:_ moving to multi-process/multi-instance.
- **Per-process scaling ceiling** — `inflightRenders`/`renderSemaphore` are per-process; `listSidecars`/`listPosts` do O(n) full-scans per call. _Revisit when:_ horizontal scaling or corpus grows to thousands.
- **SW `networkFirst` (admin bundle) doesn't fall back to cache on non-200** — only on thrown/offline error; a deploy momentarily 5xx-ing won't degrade to cached copy (deliberate, mirrors `cacheFirst`). _Revisit when:_ admin-bundle deploy resilience matters.

## Code quality

- **gdrive ↔ onedrive structural duplication** — ~150 cloned LOC; two
  parallel modules vs one Provider interface. _Revisit when:_ a third
  integration (Dropbox/iCloud) lands.
- **`draft.ts refIdsFromDoc` hand-rolls id comma-split** — duplicates what `src/lib/figure-ids.ts splitIds` canonicalizes. _Revisit when:_ next touching `draft.ts`/`figure-ids`.

## Comments (blog-comments spec §11)

- **Commenter self-service edit/delete** — needs an anon-auth scheme.
  _Revisit when:_ feedback it's needed + a chosen auth strategy.

## Deploy / config

- **Split deployed env into `config.env` + `secrets.env`** — one
  shipped env file mixes non-secret config with real secrets; a real
  split touches shared `deploy.sh`. _Revisit when:_ next touching
  `deploy.sh` env handling, or non-secret config needs to be
  git-reviewable.

## Test coverage

- **Playwright: perspective-rectify + Google OAuth callback** —
  _revisit when:_ fixture infra grows, or a UI bug ships uncaught.
- **e2e-uncovered: gdrive/onedrive pickers** — need creds + provider
  SDKs. _Revisit when:_ picker-SDK fixtures or a credentialed staging
  env exist.
- **e2e-uncovered: perspective-modal WebGL UI** — math is now
  unit-tested; only the WebGL shell is uncovered. _Revisit when:_ a
  stable headless WebGL path or a Canvas2D fallback exists.
