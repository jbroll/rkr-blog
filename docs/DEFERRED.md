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

- **No blocks-editor support for the `_site-banner` system page** — it stays markdown in `content/posts/` because the index banner reads it directly; `blocks-migrate --archive` deliberately leaves it live. _Revisit when:_ the banner needs a JSON twin / editing in the blocks editor.
- **Round-trip normalization for text blocks** — a text block whose markdown the editor would re-serialize differently (links with `&`, hard breaks, autolinks) falls back to read-only. _Revisit when:_ authors report read-only migrated paragraphs.
- **Per-instance crops** — crops are per-sidecar (global to every page using the image). _Revisit when:_ an author wants the same image cropped differently on two pages.
- **Cross-figure image move** — an image moves between figures by removing it from one and adding it in the other's dialog. _Revisit when:_ an author asks for a one-step move.
- **No video trim or poster control in the editor** — `POST /admin/video/:id/trim` works, but the video dialog sets only the video, caption and layout. _Revisit when:_ an author needs a trimmed clip.
- **Full-bleed bands sit off-center under a theme whose `main` is not centered** (tufte's 8% left margin); the `100vw` breakout assumes a centered column, as `.rkr-justify-bleed` does. _Revisit when:_ a site uses bands with tufte or another left-biased theme.
- **Grid cells cannot span columns or rows**; authors nest a grid instead. _Revisit when:_ an author needs a wide cell over two small ones.
- **No prompt to merge a row of single-image figures into one figure.** _Revisit when:_ authors build rows of single-image figures.
- **Delete on a non-empty container has no confirm and no undo.** _Revisit when:_ an author loses a section to a stray Delete.
- **Underscore escaping in `dom-markdown.ts` treats non-ASCII letters as word edges**, so `_` beside an accented letter is escaped. _Revisit when:_ a non-English page shows stray backslashes.
- **A multi-line slot value in a `# {{title}}` macro line breaks out of the heading.** Author-only and sanitized. _Revisit when:_ a macro puts a multi-line field in a heading.
- **The figure dialog does not de-duplicate repeated image ids** (the renderer does). _Revisit when:_ a page shows a repeated image the author did not intend.
- **Page settings writes an empty `excerpt` and `date` key to every file it saves.** _Revisit when:_ a diff makes it visible.
- **The toolbar title changes before the page settings save completes.** _Revisit when:_ a failed save leaves a title that was never stored.
- **Drafts carry no tree schema version.** A draft from an older bundle loads unchecked. _Revisit when:_ the block tree format changes.
- **Failed draft writes (private mode, quota) are not surfaced.** _Revisit when:_ authors report a lost edit in private browsing.
- **Edits made before the stored draft finishes loading can be overwritten by it.** _Revisit when:_ an author reports a lost first edit after a reload.
- **A conflict that follows a render failure or `pagehide` during an in-flight save defaults to Load latest**, which discards the author's own newest edit. _Revisit when:_ an author reports this.
- **A restored draft's `savedAt` drifts across reloads.** _Revisit when:_ the conflict text shows a wrong time.
- **No `beforeunload` warning for an open image dialog with unapplied edits.** _Revisit when:_ an author loses an unapplied crop or rotate.
- **The pages list filters by title on the server only.** _Revisit when:_ the page count makes a round trip per keystroke worth avoiding.
- **Unit tests for the shell wait with fixed tick loops** instead of awaiting `applyTree`. _Revisit when:_ one turns flaky.
- **`selected` is not cleared during a pending render when `opts.select` is absent.** _Revisit when:_ a toolbar appears over a block that is about to be replaced.
- **No test for an unparseable `<slug>.json` colliding with a new page's file name** (same code path as a mismatched slug). _Revisit when:_ touching the collision check in `admin-blocks.ts`.

## Organization sites

- **`default.css` sets `main { padding: 1.25rem 1rem }` under 640px and ignores `--rkr-main-pad`**, so a theme repeats the rule to put a band flush under the header on phones. _Revisit when:_ next edit to the mobile block of `default.css`.
- **The settings Home page select lists at most 1000 pages, and re-saving settings silently clears a `homePage` that has become a draft.** _Revisit when:_ a site passes 1000 pages or an author loses the home page setting.
- **Nested list item specs are forbidden only by a doc comment**; macro load does not reject a `list` inside a list `item`. _Revisit when:_ someone writes one.
- **An added empty list row saves as `{}` and renders an empty item.** _Revisit when:_ an author reports a blank card or person.
- **Removing every default list row commits `[]`, which restores the defaults**, so an author cannot blank a default list. _Revisit when:_ an author needs an empty list.
- **`.rkr-align-center` leaves block-level embed, accordion and video start-aligned.** _Revisit when:_ a centered section holds one of them.
- **The circle mask on justified and masonry figure layouts is not checked in a browser.** _Revisit when:_ a masked multi-image figure looks wrong.
- **Grid dialog: `setField('bg')` does not refresh the thumbnail, and an offline-cached editor page can show stale section theme names.** _Revisit when:_ an author reports either.
- **A dismissed announcement shows briefly before `announcement.js` hides it** (CSP blocks an inline script). _Revisit when:_ the flash draws a complaint.
- **`GET /admin/blocks/preview/:macro` renders through `expandMacro`, which fills no placeholders**, so a seed preview shows raw `{{…}}` and a light band in place of a templated theme. No UI calls it. _Revisit when:_ the palette shows macro previews.
- **Deleting the active site theme file 404s its stylesheet until a settings write or restart.** _Revisit when:_ an operator removes a theme in use.
- **`people-grid`, `icon-grid` and `logo-wall` fix `cols: 4`**, so five or six items wrap 4+1 or 4+2 and an instance cannot pick a row of five or six. _Revisit when:_ a site needs a different row length.
- **A `marquee-band` caps its marquee at `--rkr-content`**, so the scrolling text stops at the column edge instead of running edge to edge. _Revisit when:_ next marquee or band layout change.
- **A strip of page background sits between the last band and the site footer**, so a final wave edge draws over white, not the footer (ECCG Home, About, Contribute); source not traced. _Revisit when:_ a site ends a page on a waved band.
- **No seed puts several masked photos around a text block** (ECCG home "A grocery store by the community": circles in a row above the text instead). _Revisit when:_ another site asks for a scattered photo layout.

## Image pipeline

- **`buildImageMapFromOpfs` blob: URLs are never revoked** — every URL it makes reaches the rendered document and must outlive it, and the preview renders once per page load, so there is nothing to revoke yet. _Revisit when:_ the preview starts re-rendering without a full page reload.
- **Local-thumbnail blob URLs in the unified editor are never revoked.** _Revisit when:_ a long editing session grows memory.
- **HEIC originals show no local thumbnail** (the browser cannot decode them until the upload drains). _Revisit when:_ HEIC uploads are common.
- **The `/img/<id>.gif` route re-reads and re-copies the original on every Node hit** even when the cache copy exists (matters without Apache). _Revisit when:_ a deploy serves GIFs without the Apache fast path.
- **A sidecar commit racing a `.gif` request can leave a stale `<id>.gif` until gc**, and no test checks that a commit unlinks a cached `.gif`. _Revisit when:_ a stale animated GIF shows after an edit.
- **Prewarm stops at macro nodes**, so list-item images and macro band backgrounds are not prewarmed. _Revisit when:_ a macro-heavy page is slow on first view.
- **The macro figure-id prepass exists three times** (`prepareBlockRender`, `renderEditBody`, `routes/blocks.ts` `renderMacro`). _Revisit when:_ the prepass changes again.

## UI / UX

- **Likely-dead CSS from the retired editor in `src/templates/admin-styles-core.ts` and `admin-styles-dialogs.ts`** — `#rkroll-admin-root`, `-article`, `-toolbar`, `.rkr-multi*`, `.rkr-figure-actions`, `#rkr-sync-badge`, `#rkr-storage-panel`, `.rkr-admin-content` match nothing in `src/`. Many sit in shared selector lists, so removal also updates `test/templates/admin-styles.fixture.css`. `#rkroll-admin-status` is live. _Revisit when:_ next edit to those style files.

- **Owner / user management UI** — users/sessions are DB/CLI only.
  _Revisit when:_ first co-author or multi-user pivot.
- **User-facing theme picker** — theme is an env/ops action only.
  _Revisit when:_ author wants >1 theme live or per-post override.

## Performance / reliability

- **Module-level mutable singletons** — `liveInflight` + `events` emitter in `src/lib/jobs.ts`, resolved-theme cache in `src/lib/themes.ts` are process-singletons (fine for single-instance deploy). _Revisit when:_ moving to multi-process/multi-instance.
- **Per-process scaling ceiling** — `inflightRenders`/`renderSemaphore` are per-process; `listSidecars`/`listPosts` do O(n) full-scans per call. _Revisit when:_ horizontal scaling or corpus grows to thousands.
- **SW `networkFirst` (admin bundle) doesn't fall back to cache on non-200** — only on thrown/offline error; a deploy momentarily 5xx-ing won't degrade to cached copy (deliberate, mirrors `cacheFirst`). _Revisit when:_ admin-bundle deploy resilience matters.
- **An edit page can be cached into the previous build's cache during a deploy's install/activate window.** _Revisit when:_ an author sees a stale editor right after a deploy.
- **Legacy `savePost` outbox entries are skipped and never drained.** A browser upgraded with one queued keeps it (with a console warning per drain) and its edit is stranded. _Revisit when:_ someone reports a stranded edit, or one release after this ships; then delete the entries and the `savePost` op type.


## Test coverage

- **The coverage-union baseline entry for `src/admin/drainers.ts` is stale and fails the ratchet on the next edit to the file.** _Revisit when:_ next edit to `drainers.ts`; re-seed the entry in the same commit.
- **Flaky: `about-page.spec.ts:46`** — timed out once during this branch's e2e runs. _Revisit when:_ it fails twice in a row or fails on a first attempt in CI.
- **Playwright: perspective-rectify + Google OAuth callback** —
  _revisit when:_ fixture infra grows, or a UI bug ships uncaught.
- **e2e-uncovered: perspective-modal WebGL UI** — math is now
  unit-tested; only the WebGL shell is uncovered. _Revisit when:_ a
  stable headless WebGL path or a Canvas2D fallback exists.

## Deployment

- **Remove unused `GET /admin/integrations/gdrive/picker-config`** — the Picker SDK is gone; no client references it. _Revisit when:_ touching the gdrive integration routes.
- **`scripts/walk-site.sh` pagination never terminates** — it treats every
  root-relative `href` as a post slug, so chrome links (`/about`, `/login`)
  keep each page non-empty and the walk runs to its page-200 guard. Affects
  both live sites. _Revisit when:_ the walk is needed as a real check; scope
  the slug grep to `<ul class="post-list">`.
- **stockademade and code.rkroll.com have no Google OAuth client** — admin
  access is `ADMIN_TOKEN` only. _Revisit when:_ someone other than the token
  holder needs to sign in.
- **Apache fast path for `/video/` derivatives** — `deploy/hooks/apache.build.post.sh` rewrites only `/img/` to `cache/`; video mp4s and posters always proxy through Node. The rules existed in the pre-`deploy.sh` `fly-deploy/apache.conf` (git history before 2026-09-01). _Revisit when:_ video traffic is measurable on the VPS.

## Website (marketing site)

- **No app CTA on the landing page** — `website/` ships no "Try it" / sign-up button because the app has no public entry flow. _Revisit when:_ the app gains a public entry/sign-up flow; wire CTAs in `index.html` nav/hero/footer to the app domain.
