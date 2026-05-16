# Deferred items

Things we know about and have decided not to fix yet. Each entry includes:
- **Source**: the review or audit that surfaced it
- **What**: the issue
- **Why deferred**: the deliberate reasoning
- **Trigger**: the condition that should bring this back to the top of the queue

When you fix one, delete the entry. When something gets worse than expected,
promote it. Newly-discovered work goes here, not into commit messages, so
the queue is searchable.

## Security audit (post-Step-8 audit, see git log around 2026-05-07)

### M3 — Sliding-session lookup timing
**What.** `readSessionUser` does `WHERE id = ?` on a TEXT primary key;
SQLite's lookup is roughly constant-time but a second query follows.
Negligible info leak at single-author scale.

**Why deferred.** Negligible at our scale; mitigations (constant-time compare,
prepared-statement variants) cost more code than the threat warrants.

**Trigger.** If we ever expose session ids via headers/logs or open the
service to lots of concurrent unauthenticated clients.

### Multi-tenant deployability gaps
**What.** The audit's headline conclusion was that the codebase is
"deployable to a personal site as-is" but **not** suitable for multi-tenant
deployment. Specifically:
- No infrastructure-level rate limiting beyond the in-process
  `@fastify/rate-limit` (single-process; no Redis store)
- The PKCE state map is in-process (lost on restart, not shared across
  workers)
- No auth-write logging

**Why deferred.** We are explicitly building a single-author CMS.

**Trigger.** Any pivot toward shared/team/multi-tenant use.

## Code-review findings (Step 9 series)

### 9b — parseHTML doesn't recover attrs
**What.** Both `ImageNode.parseHTML` and `makeMultiImageNode().parseHTML`
match by tag/class only; there's no `getAttrs` to recover ids, alt,
caption, layout, autoplay, etc. from rendered DOM. Copy/paste between
editor sessions or document re-mount from rendered HTML would silently
drop every attribute.

**Why deferred.** Round-trip happens via prose-markdown (the canonical
storage format), not via rendered HTML. Editor sessions persist via post
saves, not clipboard. Cross-session paste isn't a current use case.

**Trigger.** If we add a "duplicate post" or "paste from preview" feature,
or if authors start losing data via clipboard round-trips.

## Step 7 follow-ups

### OneDrive picker UI (Microsoft File Picker SDK)
**What.** Server side is fully shipped (`src/lib/microsoft-graph.ts` +
`src/routes/integrations-onedrive.ts`): connect/callback/access-token/
import endpoints exist, tested with stubs. Editor has an MVP "OneDrive"
button that opens the connect flow and falls back to a manual item-id
prompt. The Microsoft File Picker SDK (analogous to Google's `gapi`
picker, served from a Microsoft CDN) is NOT integrated; the
`/picker-config` endpoint is ready for it.

**Why deferred.** End-to-end testing of the picker SDK requires an MS
Entra app registration, which is blocked on user-side credentials
(`MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, optional
`MICROSOFT_TENANT_ID`). Once those land, the SDK integration is a
mirror of `pickFromDrive` in src/admin/main.ts.

**Trigger.** When the user registers the Entra app and we want a
proper picker UI rather than the manual id MVP.

## Step 9d follow-ups (after the crop UI shipped)

### Per-instance crops in multi-image directives
**What.** Crops live on the sidecar, so cropping an image in one post
affects every post that references it. There's no editor flow today for
"different crop per directive instance" or "different crop per gallery
slot."

**Why deferred.** The current model matches the existing render-pipeline
design (sidecar.ops is the source of truth for derivatives). Per-instance
crops would require either separate sidecars per crop variant or
embedding ops in the directive node itself — significant data model
change.

**Trigger.** First time an author wants the same source image cropped
differently in two posts.

## Step 8 follow-up

### Container directive form for galleries (per-image alts with commas)
**What.** Per-image alt text now ships via a parallel `alts="a,b,c"`
attribute on every multi-image directive (gallery / carousel /
diptych / triptych). The leaf form CAN'T carry a comma inside any
single alt — those have to live in the spec's container directive
form (`:::gallery{...}` enclosing `::image{...}` children), which
hasn't been implemented yet.

**Why deferred.** The parallel-array form covers ~95% of real alt
text and required no parser change. The container form is a real
remarkDirective + renderer + editor refactor.

**Trigger.** Authoring an alt that contains a comma, or wanting
per-image captions inside a multi-image directive.

## User-requested follow-ups (2026-05-08)

### Playwright UI test coverage (expand)

**Source.** User request, 2026-05-08.

**What.** Playwright infrastructure shipped (`playwright.config.ts`,
`test-e2e/server-runner.ts`, `npm run test:e2e`, chromium installed).
Suite covers the token-login golden path + the editor image flow:

- ✅ `/admin/login` renders both options
- ✅ token-login → /admin/editor lands on the SPA shell
- ✅ wrong token → 401, no session
- ✅ insert image, set matrix, save → published `/:slug` page
  renders the figure (`editor-flow.spec.ts`, 2026-05-09)
- ✅ rotate single image → save edits → ops persist on the sidecar
  (`editor-flow.spec.ts`, 2026-05-09)
- ✅ cropper modal opens + cancels cleanly without mutating ops
  (`editor-flow.spec.ts`, 2026-05-09; covers the cropper-modal.ts
  extraction)

Outstanding editor-flow coverage:

- Open an existing post, type, save → reload → content matches
- Drag-drop an image onto the editor (the new drag-drop.ts factory
  closure pattern only has the static-import smoke from the rotate
  spec; the actual drag-drop path is unexercised)
- Perspective rectify (gated on WebGL; chromium-headless support
  varies, so this needs a feature-detect-and-skip)
- OAuth callback (Google) lands on admin dashboard (needs an inject
  hook to stub the exchange/verifier inside the long-running
  webServer; the unit suite already covers the data layer)

**Why deferred.** The remaining cases need either richer fixture
data (an existing-post round-trip needs a seeded post on disk),
synthetic DataTransfer dispatch (drag-drop), or an OAuth stub hook
in the long-running webServer.

**Trigger.** Add cases as fixture infrastructure grows, or the
first time a UI bug ships uncaught.

## 2026-05-09 audit follow-ups

These were observed during the architecture / coverage / lightbox
sweep on 2026-05-09; promoting them to deferred entries so the queue
stays current.

### gdrive ↔ onedrive structural duplication

**Source.** `npx jscpd src/` audit, 2026-05-09. ~150 of the 233
duplicated lines (77% of all clones in the codebase) sit on the
gdrive ↔ onedrive axis across server routes, server libs, and the
client-side admin integration shims.

**What.** Both providers implement the same shape: OAuth code
exchange, encrypted token storage, picker config endpoint, file
fetch + ingestion. Two parallel modules instead of one provider
interface with two adapters.

**Why deferred.** The duplication is honest (each provider has its
own SDK shape and quirks) and the surface area is small enough that
the refactor isn't blocking anything. Whole-codebase token
duplication is 2.55%, well below "act on it" thresholds.

**Trigger.** When a third integration lands (Dropbox, iCloud) — at
that point unifying the existing pair behind a Provider interface
saves real work. Otherwise it's a pure code-tidiness exercise.

### `src/admin/main.ts` is exactly at the 500-line size cap

**Source.** Size audit 2026-05-09, refreshed after per-cell editing
landed. main.ts hit 560 during the per-cell work and was brought
back to 500 by extracting the toolbar setup (admin/toolbar.ts) and
trimming inline comments. Headroom for the next SPA feature is
**zero lines** — anything new trips the gate.

**What.** The natural-cut extractions are done. Further reduction
needs a structural change: extract a per-panel `mountX(deps)` shape
(figure-attrs panel, image-edit panel, cell-selection state) so
each panel becomes its own ~80-line module that mount() composes.

**Why deferred.** No active feature is being blocked yet, but the
next will need the structural extraction first.

**Trigger.** First commit that adds non-trivial editor behavior.

### Per-cell editing UX polish

**Source.** Per-cell editing landed 2026-05-09 (selection by thumb
click, ops scoped to the active cell, e2e regression coverage).

**What.** One remaining item on top of the working baseline:

- **Active-cell persistence across re-selections.** Selecting a
  different node and returning to the same multi-image figure
  resets activeCellIndex to null. Could be preserved per-figure
  (key by figure pos or by ids string) for ergonomics.

(Visual hint when no cell is selected — shipped. Live preview
refresh after Save — shipped.)

**Why deferred.** Working baseline; cosmetic / discoverability
polish.

**Trigger.** First author feedback report on multi-image editing.

### Bundle-size monitoring

**Source.** PhotoSwipe replacement 2026-05-09. Adding PhotoSwipe
grew the public-page footprint by ~64KB (lightbox.js 15kb +
lightbox.css 4.6kb + a 59kb dynamically-imported chunk). No alert,
no budget — the change shipped silently.

**What.** Neither admin nor site bundles have a recorded size
baseline or a CI threshold. Bloat creeps in invisibly.

**Why deferred.** Current bundles are reasonable; no immediate
problem to solve.

**Trigger.** A bundle change that materially affects time-to-
interactive (e.g., a heavy editor library landing in admin/main.js).
Cheap remedy: add a `du -b static/admin static/site` line to the
gauntlet that snapshots sizes and warns on >10% growth from the
last commit.

## UI review (2026-05-11)

**Source.** Full-UI nav/aesthetic/usability review surfaced these
items alongside the ones being fixed in the same series.

### Public-side offline status indicator

**What.** The editor has a sync badge (online / offline / verifying /
conflict) bottom-right. The public site registers a service worker
and caches pages/images for offline reading but exposes no UI signal
when the reader is offline or when a cached copy is being served.

**Why deferred.** Public-side offline is best-effort already; no
reader has asked for visibility into it. The editor badge ships now
because the author actively manages drafts and queue state.

**Trigger.** First reader-side bug report that hinges on "is this
the cached version?" or a deliberate push to make the site a fully
offline-first PWA.

### "Save & view" combined editor button

**What.** After a successful save, the editor surfaces a "view →"
permalink in the status line (Phase 1a). A single "Save & view"
button that commits and navigates would shave one click off the
common publish-then-check loop, but loses the ability to keep
editing after save.

**Why deferred.** The permalink covers 90% of the ergonomics for
~2 lines of code. A combined button would need a confirm-on-dirty
flow if the second save is implicit. Wait for actual author
friction before adding it.

**Trigger.** Author feedback that the two-step save→click pattern
is friction in practice.

### Owner / user management UI

**What.** Users + sessions live in the DB; new owners are added by
hand (DB row or the invite-email path). No admin UI to list users,
revoke sessions, or rotate the bearer token.

**Why deferred.** Single-author CMS; the owner is the only user.

**Trigger.** First co-author or any multi-user pivot (also a
trigger for the multi-tenant entries above).

### User-facing theme picker

**What.** Phase 2 lands `SITE_THEME` as an env var; switching
themes is an ops action. No in-product UI to preview / pick / per-
post-override themes.

**Why deferred.** Most blogs pick one theme and stay; the env-var
path covers that. A picker only earns its complexity if the author
A/B tests themes or wants per-post overrides.

**Trigger.** Author wants more than one theme live at once or
requests a per-post override.

### More ported SSG themes

**What.** Phase 3 ports one theme (papermod-style) to prove the
contract. The library should grow over time — more Hugo / Jekyll /
Astro minimalist themes ported into `static/themes/`.

**Why deferred.** Each theme is mechanical CSS work, not a code
change. Adding them on demand keeps the bundle / static-dir lean.

**Trigger.** Specific theme request, or a public-facing site that
benefits from a curated picker.


## Post-editor pass (2026-05-11)

**Source.** Editor cleanup landed the same day surfaced several
adjacent items that don't ship in this series.

### Friendlier layout / position values

**What.** The figure-attributes panel now renames "Matrix" →
"Layout" and "Justify" → "Position", but the underlying values are
still the same machine-friendly strings: `"1x2"`, `"justified"`,
`"masonry"` for Layout and `"center"`, `"bleed"`, `"inline"` for
Position. A `<select>` with author-friendly labels (Pair / Triptych
/ Justified / Masonry / Carousel for Layout; Centered / Edge-to-
edge / Inline / Float left / Float right for Position) would read
much better than the current free-text input + jargon-y option
text.

**Why deferred.** Renaming the values is a UX pass on top of a
schema migration (the markdown directive carries the value string,
so existing posts have to keep working). The labels-only change
this commit lands is already a meaningful improvement and is the
cheap half of the work.

**Trigger.** First author who finds the current values confusing,
or any other significant figure-panel rework.

### Advanced disclosure for width / aspect / fit / autoplay

**What.** Four figure-attribute fields are presentation details
that most posts don't need: width, aspect ratio, fit, and the
carousel autoplay timer. They sit visible alongside the essentials
(alt text, caption, layout, position). A `<details>` disclosure
("Advanced") hiding them behind a single click would reduce the
panel's visual weight for the common case.

**Why deferred.** Same shape as the "friendly values" item — a
real UX rework rather than a one-line edit. None of the four fields
are currently confusing, just abundant.

**Trigger.** Author feedback that the figure panel feels busy, or
when adding more fields makes the panel unwieldy.

### Slug renaming with URL redirects

**What.** The editor hides the slug entirely; once a post is saved
its URL is fixed. Renaming a published post (changing /old-slug to
/new-slug) requires a redirect entry so inbound links don't break.
No UI or storage for this today.

**Why deferred.** This is the conventional CMS rename-and-redirect
problem — it needs a `redirects` table or sidecar file, an admin
flow to trigger the rename, and a public-route handler that serves
301s for the old slug. Real work, not in scope for "hide the slug".

**Trigger.** First author who needs to rename a published post.

### Status pill / visibility chooser

**What.** Status is still a tiny `<select>` of `draft` /
`published`. The admin posts list already shows status as a pill;
the editor could do the same — a toggle or two pills the author
clicks to flip visibility, with a clearer label ("Visibility:
Published / Draft" rather than "Status").

**Why deferred.** Cosmetic; the current select works fine and
two-value selects are the right primitive for a binary toggle. Worth
considering when the editor's top form gets a broader visual pass.

**Trigger.** Top-form layout pass, or when status grows a third
value (e.g. "scheduled").

## Local-first architecture review (rosy-tickling-meadow plan)

### Pre-resize coord divergence — narrowed to HEIC-on-non-Safari
**Source.** Local-first correctness audit, Apr 2026. Mostly
addressed by client-side ingest resize (`src/admin/ingest-resize-client.ts`,
landed alongside this entry's revision).

**What.** The original bug: server's `ingestStream` resizes large
originals at ingest; client's OPFS holds the raw upload bytes; an
offline editor canvas in raw-upload coord space emits ops the
server's resized base can't apply. Now that the client resizes
before uploading, the bytes the client edits with and the bytes
the server stores are the same — coord-divergence is closed for
every format the browser can decode (JPEG, PNG, WebP, AVIF, GIF
first-frame).

**Remaining gap:** `createImageBitmap` can't decode HEIC outside
Safari. A user on Chrome/Firefox uploading an iPhone HEIC falls
through to the raw-upload path; the server resizes; if the user
then edits offline (canvas-loaders' OPFS fallback decodes via
`<img>` which CAN decode HEIC in some non-Safari builds), coords
diverge.

**Why deferred.** Narrow trigger window (HEIC + non-Safari + edit
before drain). Real fix needs either HEIC transcode to WebP
client-side (libheif WASM) or a server endpoint that returns the
resized version's dimensions so the client can scale ops at
commit time. Both are non-trivial.

**Trigger.** A user reports edits applied wrong after editing a
HEIC photo offline in Chrome / Firefox.

### Persisted retry budget across reload
**Source.** Local-first correctness audit, Apr 2026.

**What.** `src/admin/sync.ts` keeps the per-entry `attempts`
counter in memory. A tab reload resets it. A persistently failing
entry burns the in-memory budget, halts the drain, then on reload
gets 5 fresh attempts — effectively infinite total attempts spread
across sessions.

**Why deferred.** Reload-resets-budget matches user mental model
("refresh the page to retry"). Persisting attempts would require
a schema migration on `OutboxEntry`. The halt status badge already
surfaces persistent failures via the status panel.

**Trigger.** A user reports a stuck drain that they can't shake by
reloading (which would mean the entry is genuinely poisoned and
the retry budget should ratchet).

## UI e2e coverage — skipped surfaces

Sub-50% UI source files NOT covered by the May 2026 e2e push
because they're not reasonably testable from a headless Playwright
run. Tracked here so a future credential/SDK change unlocks them.

### `src/admin/pick.ts` (0%, 7 LOC)
**What.** Thin wrapper around `<input type="file">.click()` that
returns a `Promise<File[]>`. Existing flows use Playwright's
`setInputFiles` which writes the FileList directly, bypassing the
click → OS file picker path.

**Why deferred.** Driving the OS picker requires either headed
browser + a robot library, or a fixture-server intercept of the
file-input dialog. Not worth it for 7 lines.

**Trigger.** Substantial refactor of the upload flow that makes
pick.ts the unique entry point.

### `src/admin/integrations/gdrive.ts` (2%, 53 LOC) + `onedrive.ts` (0%, 26 LOC)
**What.** Google Drive + OneDrive picker integration. Require
provider OAuth credentials (`GOOGLE_CLIENT_ID`, `MICROSOFT_CLIENT_ID`)
and the provider-hosted picker SDKs.

**Why deferred.** Out-of-process dependencies that can't run in
a hermetic test environment. Existing unit tests cover the
server-side OAuth flow (`test/routes/integrations-*.test.ts`)
with stubs.

**Trigger.** When test fixtures for the picker SDKs become
available, or when integration tests against a credentialed
staging environment are introduced.

### `src/admin/perspective-modal.ts` (1%, 73 LOC) + `src/lib/canvas-math.ts` (23% partial)
**What.** Perspective rectify uses WebGL for the homography
rendering. The math is in canvas-math.ts; the UI shell in
perspective-modal.ts.

**Why deferred.** Chromium headless support for WebGL varies
across versions (`--use-gl=swiftshader` flag is required and not
always stable). E2e tests of perspective tend to flake across
CI runs.

**Trigger.** When Playwright + chromium settle on a stable
headless WebGL path, or when we ship a Canvas2D fallback
implementation.

## Residual e2e flakes (2026-05-13 flake-investigation pass)

**Source.** Full-suite reruns during the drain-timing flake fix
(commit 5fa42e2). Three flake families were stabilized — thumb
visibility race, online-state probe race, drain-poll timeouts.
Two pre-existing flakes remain at low rates.

### `editor-flow.spec.ts:442` — crop save → blob URL falls back to /admin/preview

**What.** Test expects the thumb's src to be a `blob:` URL after a
crop save. Under suite load the assertion occasionally sees
`/admin/preview/<id>` instead, which is the catch-branch fallback
in `refreshImagePreview` (`src/admin/canvas-loaders.ts:200-211`).
The canvas pipeline threw somewhere between `loadOriginal` and
`setEditorImageSrc` and the error was swallowed into `setStatus`.

**Why deferred.** Passes 100% in isolation; only reproduces under
sequential e2e load. The fallback IS correct user-visible behavior
(the preview URL still resolves to a working derivative). The flake
is a real but rare bug in the canvas pipeline's error handling that
needs reproduction — likely a transient `loadOriginal` fetch
failure or an `originalCache` LRU eviction race.

**Trigger.** When a user reports "my crops disappear after save" or
when adding an instrumented run that captures `console.error` from
the canvas pipeline across a full suite.

### `public-figures.spec.ts:134` — carousel autoplay doesn't start

**What.** Test expects `aria-pressed="true"` on the carousel play
button after `page.goto` — autoplay should auto-start when
`prefers-reduced-motion: no-preference`. Headless Chromium
occasionally reports the play button as `aria-pressed="false"`,
suggesting `start()` was either never called or `stop()` fired
immediately afterwards (mouseenter / focusin / visibilitychange).

**Why deferred.** Passes 100% in isolation. Carousel start logic
in `src/site/carousel.ts:135` runs on mount; no obvious race in
the code. The flake is environmental (headless tab-visibility
quirks) rather than a code bug.

**Trigger.** If the failure rate climbs above ~1/6 runs, or when
adding a real user-facing reduced-motion preference toggle would
benefit from clearer test coverage anyway.

## Performance / reliability

### Post-deploy "30s to first page" — deploy window + SW no-timeout nav

**Source.** Targeted boot-path profile, 2026-05-16 (operator reported
the login page taking 30s right after a deploy).

**What.** The Node service is *not* the bottleneck — journald shows
ExecStartPre (`site-admin init`: dirs + migrations) = ~130 ms and
process-start → `rkr-blog listening` = ~630 ms, i.e. ≈0.8 s total
process-down → serving, consistent across restarts, `NRestarts=0`,
`Type=simple`. The 30 s comes from two compounding gaps *around* the
server:

1. **Deploy has no health gate.** `node_app/install.sh` does
   `rsync -a --delete staging → app_path` over the live tree, then
   `node_app/start.sh` does `systemctl restart` + a blind `sleep 2`
   (no `/health` poll, no zero-downtime swap). Apache is not gracefully
   gated against the upstream being momentarily absent.
2. **SW navigation SWR has no network timeout / no fallback.**
   `sw-core.ts` `staleWhileRevalidate` returns `hit ?? network` and
   awaits `network` unbounded. `sw-register.ts` posts
   `rkr-pages-flush` on the login/logout redirect, which empties the
   PAGES cache — so on exactly the login navigation `hit` is
   `undefined` and the SW blocks on a single network fetch. If that
   fetch lands during the restart window, Apache mod_proxy
   connect/retry holds it ~30 s before the (by-then-up) server
   answers. After it clears, every request is sub-2 ms (journal
   13:58–13:59).

**Why deferred.** Single-author site; the blip is once per deploy and
self-clears. Fix involves a deploy-script change (external repo,
`/home/john/src/deploy.sh`) and/or SW semantics with auth-cache
interactions — both want deliberate design, not a hotfix. Resolution
options (pick one or both, design needed):
- Deploy-side: health-gate `start.sh` (poll `/health` before
  completing) or true zero-downtime (start new, health-check, swap).
- SW-side: race the navigation fetch against a short timeout with a
  lightweight loading/offline fallback so a slow upstream degrades to
  seconds, not 30 s. Mind the login-flush interaction (login is the
  worst case by construction).

**Trigger.** If the post-deploy stall is reported again, deploys get
more frequent, or the site moves toward multiple authors / higher
traffic where a 30 s window is user-visible to non-operators.

## Task 6 code-quality review (blog-comments implementation, 2026-05-16)

### SW stale-while-revalidate vs. freshly-published comments

**Source.** Task 6 code-quality review, blog-comments implementation (2026-05-16).

**What.** Anonymous public post pages (`GET /:slug`) are cached by the service
worker with a stale-while-revalidate strategy (`sw-core.ts`); there is no
`Cache-Control: no-store` on anonymous responses. Task 6 added per-request
comment HTML to those pages. Consequence: after a comment is approved/published
(or a new ham comment auto-publishes), a returning reader holding a SW-cached
copy will not see the new comment until the SW background revalidation completes
and they navigate again; an explicit reload bypasses this via the revalidation
path. Pre-Task 6 this did not matter because post pages carried no dynamic
per-request content.

**Why deferred.** The fix options have real trade-offs and warrant a deliberate
decision, not an ad-hoc choice: (a) send `Cache-Control: no-store` on post pages
— always fresh but loses offline reading and repeat-visit speed; (b) shorten the
SWR cache TTL; (c) post a `rkr-pages` cache-flush `postMessage` (or bump cache
version) when a comment is approved in the admin moderation route. None is clearly
correct without product input.

**Trigger.** Revisit if/when readers report newly-posted comments not appearing
without a hard refresh, or when implementing comment-approval UX.

## blog-comments deferred items (design 2026-05-16)

### Email notifications on new / queued comments

**Source.** blog-comments spec §11 (design 2026-05-16).

**What.** Notify the site author by email when a comment is submitted
(or when a spam-flagged comment lands in the moderation queue).

**Why deferred.** No email infrastructure exists (no SMTP config, no
transactional-email provider). Adding it is a separate integration
project.

**Trigger.** When an email sender (SMTP or transactional API) is
available and the author wants async moderation alerts.

### Commenter self-service edit / delete

**Source.** blog-comments spec §11 (design 2026-05-16).

**What.** Allow a commenter to edit or delete their own comment after
submission, within a time window.

**Why deferred.** Requires either a session / magic-link scheme for
anonymous commenters or a login requirement — significant auth surface
not in v1 scope.

**Trigger.** Author or commenter feedback that post-submission correction
is needed, paired with a chosen auth strategy for anonymous users.

### Importing WordPress spam / trash / pending comments

**Source.** blog-comments spec §11 (design 2026-05-16).

**What.** `import-wp-comments` only fetches approved comments via the
public WP REST API. Spam, trash, and pending comments are inaccessible
without authenticated WP credentials.

**Why deferred.** Approved comments are the only ones worth recovering
for a public-facing import. Accessing non-public comment statuses
requires WP application passwords or cookie auth — scope creep for a
one-time migration.

**Trigger.** If recovering WP pending/spam comments becomes necessary
and WP auth credentials are available.

### Multi-level (deeper than one) comment threading

**Source.** blog-comments spec §11 (design 2026-05-16).

**What.** The current schema and `src/lib/comments.ts` enforce a maximum
of one level of threading (reply to a top-level comment only). Arbitrary
nesting is not supported.

**Why deferred.** Nested threading complicates rendering, moderation
ordering, and the flattening logic for WP import. Single-level covers the
common case for a personal blog.

**Trigger.** Sustained author or reader demand for sub-replies, or a
comment volume that makes flat threading unwieldy.

### CAPTCHA / third-party bot protection

**Source.** blog-comments spec §11 (design 2026-05-16).

**What.** The anti-abuse layer (honeypot, min-fill-time, rate limit) has
no CAPTCHA or external bot-detection service.

**Why deferred.** CAPTCHAs (reCAPTCHA, hCaptcha, Turnstile) require
loading third-party scripts, which breaks the strict CSP and adds reader
friction. The existing lightweight guards are sufficient for a low-traffic
personal blog.

**Trigger.** Sustained spam volume that bypasses the current guards, or a
relaxation of the CSP that makes third-party script inclusion acceptable.

### Split deployed env into `config.env` (non-secret) + `secrets.env`

**Source.** Blog-comments deploy (2026-05-16): `OLLAMA_BASE_URL` and other
non-secret runtime config (`SITE_ROOT`, `PUBLIC_BASE_URL`, `SPAM_MODEL`,
timeouts) currently live in the gitignored `secrets.env` alongside real
credentials (`ADMIN_TOKEN`, `GOOGLE_CLIENT_SECRET`, …).

**What.** Separate non-secret, reviewable configuration into a
version-controlled `config.env` and keep only true secrets in the
gitignored `secrets.env`, merged into the single shipped
`/etc/rkr-blog.env` at deploy time.

**Why deferred.** The `deploy.sh` `node_app` module ships exactly one env
file (`NODE_APP_SECRETS_FILE` → `/etc/<app>.env`); a real split requires a
change to **shared deploy infrastructure** (`deploy.sh` is consumed by
wicketmap, gpu-services, and others) or a per-project build hook that
concatenates both files. Cross-cutting change deserving its own design +
cross-app testing, not a bolt-on during the comments rollout.

**Trigger.** When next touching `deploy.sh` env handling, or when a
non-secret config change needs to be reviewable in git history.

## Planned features

### Post teaser on the logged-out homepage

**Source.** Feature request; design captured in
[`docs/teaser-feature.md`](teaser-feature.md).

**What.** Feature the top post of the anonymous homepage list as a
teaser (hero image + first paragraph), gated behind a `postTeaser`
blog-global config toggle (default off). Full design, file list, edge
cases, and test plan are in the linked doc.

**Why deferred.** Design approved; implementation not yet scheduled.

**Trigger.** When picking up the next homepage/UX work item, or on
explicit go-ahead to implement.

## User-requested follow-ups (2026-05-16)

### Drag-and-drop image reordering in the figure editor

**Source.** User request, 2026-05-16.

**What.** In the figure editor, multi-image figures (gallery /
carousel / diptych / triptych) have no way to reorder their images by
dragging. Order is whatever the ids were inserted in; changing it
means editing the `ids=` list by hand.

**Why deferred.** Needs a drag-reorder interaction in the editor
(pointer/keyboard a11y, drop-target affordances) plus write-back to
the directive's `ids` order — non-trivial UI work, not yet scheduled.

**Trigger.** When picking up figure-editor UX work, or the first time
an author asks how to reorder gallery images.

### Comment bubble floated right in the post title

**Source.** User request, 2026-05-16.

**What.** The "add a comment" affordance should be a bubble floated
to the right within the post title row, matching the treatment on
roll-along.rkroll.com (reference implementation), rather than its
current placement.

**Why deferred.** Cosmetic/layout change on the comments UI; bundle
it with the next comments-UI or post-template pass rather than a
one-off. Mirror the roll-along.rkroll.com markup/CSS.

**Trigger.** Next comments-UI or post-title layout work, or explicit
go-ahead.

