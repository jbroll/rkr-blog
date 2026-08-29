# Deferred items

Known work we've deliberately not done yet. One line each, grouped by
area, with the condition that should pull it back into the queue.
Delete an item when it ships; promote it (move up, add detail) if it
gets worse than expected. Fuller rationale for any item lives in the
git history of this file and the commit/spec that introduced it.

Format: **item** — _revisit when:_ trigger.

## Security

- **Roles stored but never enforced** — `owner` / `editor` are assigned from the invite and carried on the user, but no route consults `role`; every admin route requires only a user. _Revisit when:_ a second person is invited, or an `editor` invite is meant to withhold anything.
- **Multi-tenant deployability gaps** — no infra rate-limit (only
  in-process `@fastify/rate-limit`), in-process PKCE state, no
  auth-write logging. _Revisit when:_ any shared/team/multi-tenant
  pivot.
- **Provider media fetches follow redirects without per-hop SSRF re-validation** — trusted single-author model; `url-safety.ts` guards the initial URL only. _Revisit when:_ opening authoring to untrusted/multi-author posters.
- **Slug rename + comment orphan cascade** — renaming a .md file AND changing its `slug` field simultaneously triggers the orphan-delete path and CASCADE-deletes that post's comments. _Revisit when:_ a migration or bulk-rename operation needs comment preservation; fix: update the slug column first (reindex), then rename the file.
- **Integration OAuth PKCE verifier in browser cookie** — gdrive + onedrive integration flows store the PKCE `code_verifier` in a JSON-serialised cookie (primary auth flow already moved this server-side). State is also not bound to session userId. _Revisit when:_ cloud-drive integrations are used in a multi-user context or security posture requires it; fix: mirror the `pendingFlows` Map pattern from `auth.ts`.

## Deployment

- **Legacy WordPress permalinks 404** — both migrated sites used
  `/%year%/%monthnum%/%day%/%postname%/`; rkr-blog serves `/:slug`.
  Import preserves slugs, so breakage is limited to ~47 in-content links
  (29 roll-along, 18 stockademade) plus external inbound links. _Revisit
  when:_ those links matter; fix is a `GET /:y/:m/:d/:slug` route that
  301s to `/:slug` when the slug is a published post.

## WordPress import

- **Push drops resolved tags** — `import-wp push` doesn't forward the post's tag names to `/admin/posts`, so pushed posts arrive untagged even when the source resolved tags. _Revisit when:_ a source with tags is pushed (the roll-along backup has no `post_tag` rows).
- **`_binary` / `0x` hex literals stored as text** — the dump converter writes blob literals verbatim into TEXT columns rather than decoding them. _Revisit when:_ a dump whose post content or options carry real binary data is imported.
- **Failed conversion leaves a partial `.db`** — `convertDump` writes in place, so an error mid-run leaves a truncated database at the target path. _Revisit when:_ conversion runs unattended or feeds an automated pipeline; fix is convert-to-temp then rename.

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
- **`admin/main.js` + `main.css` double-cached, bare and `?v=`-stamped** — ~475 KB of the ~1.2 MB precache is duplicate: relative imports reach them bare, the shell stamps them by name (`scripts/gen-precache.ts`). _Revisit when:_ precache quota pressure causes eviction.

## Image pipeline

- **Prepass-equivalence test doesn't cover variant fidelity** — `test/lib/image-map-equivalence.test.ts` strips every `<source>` line before comparing, so a format/width divergence between the server and client prepasses wouldn't be caught by it. _Revisit when:_ either prepass's variant generation changes.
- **`buildImageMapFromOpfs` blob: URLs are never revoked** — bounded to one map per page load today; a re-rendering preview would leak. _Revisit when:_ the preview starts re-rendering without a full page reload.
- **`scanPostForImageIds` duplicates prefix resolution** — `src/lib/posts.ts` carries a third independent copy of the id-prefix-resolution rule that `src/lib/id-resolve.ts` was created to unify. _Revisit when:_ next touching either.

## UI / UX

- **Owner / user management UI** — users/sessions are DB/CLI only.
  _Revisit when:_ first co-author or multi-user pivot.
- **User-facing theme picker** — theme is an env/ops action only.
  _Revisit when:_ author wants >1 theme live or per-post override.

## Performance / reliability

- **Module-level mutable singletons** — `liveInflight` + `events` emitter in `src/lib/jobs.ts`, resolved-theme cache in `config.ts` are process-singletons (fine for single-instance deploy). _Revisit when:_ moving to multi-process/multi-instance.
- **Per-process scaling ceiling** — `inflightRenders`/`renderSemaphore` are per-process; `listSidecars`/`listPosts` do O(n) full-scans per call. _Revisit when:_ horizontal scaling or corpus grows to thousands.
- **SW `networkFirst` (admin bundle) doesn't fall back to cache on non-200** — only on thrown/offline error; a deploy momentarily 5xx-ing won't degrade to cached copy (deliberate, mirrors `cacheFirst`). _Revisit when:_ admin-bundle deploy resilience matters.
- **GC never reclaims orphaned originals** — `originals/<aa>/<bb>/<id>.<ext>` files accumulate forever if their posts are deleted. _Revisit when:_ disk usage becomes a concern; fix requires a cross-referencing pass between originals/ and all sidecar files.
- **`check-bundle-size.ts --write` is documented but not implemented** — the failure message tells you to re-run with `--write` to bump the baseline; the script parses no `argv` and always exits 1 on overage regardless of the flag. _Revisit when:_ next touching this script; either implement the flag or drop it from the message.


## image-pwa (apps/image-pwa)

- **PWA e2e smoke not in CI** — the standalone editor (upload → rotate → crop → download) is verified by headless workflow tests + a manual browser smoke, but has no Playwright spec in the suite (the webServer serves the blog, not the app). _Revisit when:_ the app gains non-trivial UI or a regression ships; wire a static-serve route for `apps/image-pwa/dist`.
- **PWA installability (SW scope + icons)** — `sw.js` builds to `dist/` so its scope is `dist/` (doesn't cover `start_url: ./`), and the manifest ships no icons (the org-hooks `eof-ws` hygiene check rejects binary PNGs, so icons can't be committed until that's fixed to skip binaries). The app loads/works fully; only the install badge is affected. _Revisit when:_ installability matters; emit `sw.js` at the served root and add icons once the hook handles binaries.
- **Tilt slider uses delta-from-last semantics** — the slider applies `appendRotate(newVal - prevVal)`, so its absolute value can diverge from the net rotation after 90° buttons (deltas still accumulate correctly). _Revisit when:_ a UX report calls it confusing; track a dedicated tilt op.
- **Package canvas layer not c8-gated** — `packages/image-edit/src/canvas/**` (DOM/UI) is excluded from unit coverage like `src/admin`; only `src/core` is c8-gated, the canvas layer is e2e/manual-verified. _Revisit when:_ the union e2e ratchet baseline is seeded.

## Video

- **Video sidecars not synced to OPFS** — `admin-post-bundle.ts` ships only image sidecars, so the editor's OPFS `buildVideoMapFromOpfs` sees no video sidecars and `/admin/view/:slug` previews render `<!-- missing video -->`. Public rendering is unaffected (server `buildVideoMap` reads the real sidecars). _Revisit when:_ completing the editor video integration; wire video sidecars into the post bundle + `pin.ts`.
- **No admin toolbar button to insert a video** — authors reach `::video` via the editor hook/API or raw markdown today. _Revisit when:_ video editing is surfaced in the UI; add a toolbar insert + drop handler.
- **`video gc` not implemented** — `bin/site-admin video probe` ships; GC of orphaned videos (masters/sidecars whose posts are gone) does not. _Revisit when:_ disk usage from deleted posts' videos matters; mirror the image GC pass over `originals/videos` + `sidecars/videos`.
- **Video derivatives not prewarmed on post save** — `admin-prewarm.ts` walks image refs only, so a trimmed video hits the 202+retry path on first public request. _Revisit when:_ first-read latency for videos matters.

## Test coverage

- **Playwright: perspective-rectify + Google OAuth callback** —
  _revisit when:_ fixture infra grows, or a UI bug ships uncaught.
- **e2e-uncovered: perspective-modal WebGL UI** — math is now
  unit-tested; only the WebGL shell is uncovered. _Revisit when:_ a
  stable headless WebGL path or a Canvas2D fallback exists.
- **Flaky: `editor: offline ops bake drains on reconnect`** — save-btn disabled check races `ensureLocalState`. _Revisit when:_ seen failing again; add explicit wait for network idle before the disabled assertion.
- **Flaky: `editor: rotate single image then save edits`** — 404 on `loadOriginal` / preview during rotate races OPFS-to-server drain under CI load. _Revisit when:_ seen failing outside CI load conditions; add explicit drain-wait.
- **Flaky: `editor: online-save 409 surfaces conflict`** — mtime-bump + 409 path is timing-sensitive; fails under CI server load. _Revisit when:_ seen failing locally; increase server-response timeouts.

## Website (marketing site)

- **No app CTA on the landing page** — `website/` ships no "Try it" / sign-up button because the app has no public entry flow. _Revisit when:_ the app gains a public entry/sign-up flow; wire CTAs in `index.html` nav/hero/footer to the app domain.
- **Unknown paths fall back to `index.html` (200, not 404)** — the static Apache vhost serves `index.html` for any missing path, so e.g. `/deploy.conf` returns the homepage instead of 404. Harmless (no real file is exposed) but not ideal for a non-SPA. _Revisit when:_ it matters for SEO/correctness; drop the fallback for this static vhost.
