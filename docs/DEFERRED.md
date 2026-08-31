# Deferred items

Known work we've deliberately not done yet. One line each, grouped by
area, with the condition that should pull it back into the queue.
Delete an item when it ships; promote it (move up, add detail) if it
gets worse than expected. Fuller rationale for any item lives in the
git history of this file and the commit/spec that introduced it.

Format: **item** — _revisit when:_ trigger.

## Security

- **Roles stored but never enforced** — `owner` / `editor` are assigned from the invite and carried on the user, but no route consults `role`; every admin route requires only a user. Stub `requireOwner` at `src/lib/auth-middleware.ts` (tested in `test/lib/require-owner.test.ts`) enforces `role === 'owner'`. _Revisit when:_ second editor invited — wire `requireOwner` to owner-only routes.
- **Multi-tenant deployability gaps** — no infra rate-limit (only
  in-process `@fastify/rate-limit`), in-process PKCE state, no
  auth-write logging. _Revisit when:_ any shared/team/multi-tenant
  pivot.


## WordPress import

- **`_binary` / `0x` hex literals stored as text** — the dump converter writes blob literals verbatim into TEXT columns rather than decoding them. _Revisit when:_ a dump whose post content or options carry real binary data is imported.

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
- **Offline-launched client can drain a stale bundle to a newer server** — network-first navigation narrows the window to a single launch but does not close it; the fix is a build-hash check at drain time in the drain routes (`/admin/posts`, `/admin/upload`, `/admin/sidecar/:id/commit`), which changes the sync contract. _Revisit when:_ a sync-breaking schema change ships.
- **A queued outbox entry can sit unsynced until the next online transition** — `tryDrain` in `src/admin/sync.ts` takes the leader lock with `ifAvailable`, and a drain that finds an empty queue publishes `idle`. An entry appended while a previous drain is still finishing gets a no-op `tryDrain` and nothing re-triggers it; there is no periodic sweep. Found while de-flaking `editor: offline rotate+save queues setOps+bake, drains on reconnect`. _Revisit when:_ an author reports edits that never reached the server; fix is a re-check after the lock releases, or a periodic sweep.

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


## image-pwa (apps/image-pwa)

- **PWA e2e smoke not in CI** — the standalone editor (upload → rotate → crop → download) is verified by headless workflow tests + a manual browser smoke, but has no Playwright spec in the suite (the webServer serves the blog, not the app). _Revisit when:_ the app gains non-trivial UI or a regression ships; wire a static-serve route for `apps/image-pwa/dist`.
- **PWA installability (SW scope + icons)** — `sw.js` builds to `dist/` so its scope is `dist/` (doesn't cover `start_url: ./`), and the manifest ships no icons (the org-hooks `eof-ws` hygiene check rejects binary PNGs, so icons can't be committed until that's fixed to skip binaries). The app loads/works fully; only the install badge is affected. _Revisit when:_ installability matters; emit `sw.js` at the served root and add icons once the hook handles binaries.
- **Tilt slider uses delta-from-last semantics** — the slider applies `appendRotate(newVal - prevVal)`, so its absolute value can diverge from the net rotation after 90° buttons (deltas still accumulate correctly). _Revisit when:_ a UX report calls it confusing; track a dedicated tilt op.
- **Package canvas layer not c8-gated** — `packages/image-edit/src/canvas/**` (DOM/UI) is excluded from unit coverage like `src/admin`; only `src/core` is c8-gated, the canvas layer is e2e/manual-verified. _Revisit when:_ the union e2e ratchet baseline is seeded.

## Test coverage

- **Playwright: perspective-rectify + Google OAuth callback** —
  _revisit when:_ fixture infra grows, or a UI bug ships uncaught.
- **e2e-uncovered: perspective-modal WebGL UI** — math is now
  unit-tested; only the WebGL shell is uncovered. _Revisit when:_ a
  stable headless WebGL path or a Canvas2D fallback exists.

## Website (marketing site)

- **No app CTA on the landing page** — `website/` ships no "Try it" / sign-up button because the app has no public entry flow. _Revisit when:_ the app gains a public entry/sign-up flow; wire CTAs in `index.html` nav/hero/footer to the app domain.
