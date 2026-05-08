# Deferred items

Things we know about and have decided not to fix yet. Each entry includes:
- **Source**: the review or audit that surfaced it
- **What**: the issue
- **Why deferred**: the deliberate reasoning
- **Trigger**: the condition that should bring this back to the top of the queue

When you fix one, delete the entry. When something gets worse than expected,
promote it. Newly-discovered work goes here, not into commit messages, so
the queue is searchable.

## ::figure editor toolbar UX refresh

**Source.** Spec.md §9 unification, follow-up after the legacy
ProseMirror node types were removed.

**What.** The editor now stores all images as a single `figure`
node. The toolbar still has 5 buttons (Image / Gallery / Carousel /
Diptych / Triptych) — each one pre-fills different `matrix` /
`timer` defaults via the `figureForImage` and `figureForMulti`
adapters in main.ts. A unified UX would collapse these into:

- "Insert figure" button with a matrix selector (1x1, 1x2, 1x3,
  NxM, justified, masonry, carousel)
- A single attribute panel surfacing matrix / justify / width /
  aspect / fit / alts / captions / caption / timer
- Per-image alt + caption slot management
- Selected-cell cropper for multi-image figures (currently the
  cropper / ops UI engages only when the figure resolves to single-
  image mode via figureKind)

**Why deferred.** This is genuine UX work that benefits from
in-browser iteration; the current 5-button toolbar has no
correctness issues (round-trip is verified by tests).

**Trigger.** When there's an in-browser iteration loop available
for the operator (real photos, real preview), or when adding a new
multi-image affordance.

## src/admin/main.ts is too large

**What.** The editor entry point is ~1900 lines and covers many
concerns: ProseMirror node + toolbar + attribute panel + cropper +
ops pipeline + Drive integration + OneDrive integration + save flow.
A 500-line per-file commit hook (DEFERRED entry below) would block
any commit that touches it. The right shape is to split into
modules — e.g. `src/admin/figure-node.ts`, `src/admin/toolbar.ts`,
`src/admin/attribute-panel.ts`, `src/admin/image-edit.ts`,
`src/admin/integrations/{gdrive,onedrive}.ts`.

**Why deferred.** The editor refactor is mechanical but extensive
and benefits from in-browser smoke testing after each split.

**Trigger.** Land alongside the toolbar UX refresh, or before
tightening the size hook to fail-on-existing.

## Tighten the per-file size hook to fail-on-existing

**What.** `.githooks/pre-commit` already enforces the 500-line
ceiling for new files in production source (`src/`, `bin/`) and
rejects any growth in already-oversized files (warn-on-existing).
Tests are exempt from the size check — coverage growth is a feature.
Once the existing production offenders are split (`src/admin/main.ts`,
`src/routes/admin.ts`, `src/lib/wp-import.ts`, `src/widgets/figure.ts`),
the hook should be tightened so the warn-on-existing branch becomes
a FAIL. That removes the special case and keeps production code
under the limit.

**Why deferred.** Four production-source files are over 500 lines
today. Failing on them all immediately would block every commit
until they're refactored — a disruptive forced march.

**Trigger.** When the last warn-on-existing production file drops
below 500 lines (i.e., `wc -l` of every staged file under `src/`
or `bin/` returns ≤ 500). At that point flip the warn branch in
`.githooks/pre-commit` to `exit 1`.

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

### 9a — Per-keystroke transactions in image attribute panel
**What.** `commitAttr` in the editor fires on every input event for alt and
caption, creating one TipTap transaction (and one undo entry) per character.
For long captions, the undo stack becomes per-character.

**Why deferred.** Real refactor — needs a debounce or a "don't add to
history" intermediate transaction with a flush on blur. The author can still
type fine; the undo behavior is just chunkier than ideal.

**Trigger.** First time an author complains about undo granularity, or
when we add other free-text panel fields where this matters more.

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

## UI review (post-Step-9 audit, 2026-05-07)

### Lightbox figcaption not associated with displayed image
**What.** The overlay's `<figcaption>` element is positioned over the
image but isn't connected via `aria-describedby`. Screen readers
treating the dialog as an island won't read the caption alongside the
img.

**Why deferred.** Improvement, not violation — the dialog still
announces correctly via aria-modal + the img's alt + the figcaption
being inside the same dialog tree. Real fix is one-line + a tested
behavior change to the overlay structure (single `<figure>`).

**Trigger.** First screen-reader user reports unclear caption.

### `position=inline` + `caption=` silently drops the caption
**What.** Site.css sets `display: none` on figcaption inside
.rkr-pos-inline (`static/site.css:287`). The image widget happily
emits the figcaption HTML; CSS hides it. Author sees their caption
disappear.

**Why deferred.** Edge case — inline images are a small minority of
authoring patterns. Real fix is editor-side: when position changes
to inline and caption is non-empty, surface a warning OR auto-clear
the caption.

**Trigger.** First time an author hits this and is confused.

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

### EXIF rotation not honored on import

**Source.** User report, 2026-05-08.

**What.** Photos with EXIF orientation tags (e.g. iPhone portraits
saved as landscape with `Orientation=6`) come out sideways through
the image pipeline. `sharp` has `.rotate()` which auto-applies the
orientation tag, but it's only effective when called *before* any
resize — and it must be called explicitly. Need to audit
`src/widgets/figure.ts`, `src/lib/render.ts`, and the upload path
in `src/routes/admin.ts` to confirm we invoke `.rotate()` first in
every sharp pipeline, then strip orientation from the metadata so
the rendered output is upright with no EXIF rotation re-applied
client-side. Add a regression test using a fixture image with
`Orientation=6`.

**Why deferred.** Captured here so it isn't lost; the fix is a
small audit + one-line change per pipeline + a test fixture, but
it cuts across multiple files and benefits from being a focused
commit rather than slipped into unrelated work.

**Trigger.** Next image-pipeline change, or first time the author
uploads a photo that comes out rotated.

### Retry-with-backoff on image load failure

**Source.** User request, 2026-05-08.

**What.** When the browser's `<img>` element fires `error` (network
hiccup, CDN miss, sidecar still rendering on the server), the
image just stays broken. We should attach an `onerror` retry on
the public site (lightbox, carousel, in-page figures) with
exponential backoff — say 3 retries at 500ms / 2s / 8s with a
small jitter, and a final visible "couldn't load" placeholder.
Likely lives in `src/site/lightbox.ts` and `src/site/carousel.ts`,
plus a small shared helper for in-page imgs.

**Why deferred.** Not blocking — failure rate is low on a healthy
deploy. But it'll matter the first time someone hits a render
job that's still in flight.

**Trigger.** First user-visible image-load failure report, or
when adding any caching CDN that adds variability.

### Refactor production source files to under 500 lines

**Source.** User request, 2026-05-08; companion to the size-hook
entries above.

**What.** Four production-source files currently exceed the
500-line ceiling enforced by `.githooks/pre-commit` (tests are
exempt from the size check):

| File | Lines | Suggested split |
|---|---|---|
| `src/admin/main.ts` | 1900 | see "src/admin/main.ts is too large" entry |
| `src/routes/admin.ts` | 1026 | extract `admin/upload.ts`, `admin/posts.ts`, `admin/reset.ts` route modules |
| `src/lib/wp-import.ts` | 580 | extract `wp-import/parse.ts`, `wp-import/push.ts`, `wp-import/media.ts` |
| `src/widgets/figure.ts` | 512 | extract `figure/layout.ts` (matrix/justified/masonry) |

Each split should preserve test coverage and be its own commit so
review is tractable.

**Why deferred.** Mechanical but extensive; benefits from
in-browser smoke testing for the editor pieces and from being
sequenced (smaller files first, build confidence).

**Trigger.** Tackle in a dedicated refactor sprint, or piecemeal
whenever a feature touches one of these files.

### Admin token login button (cookie session via shared secret)

**Source.** User request, 2026-05-08.

**What.** Today the admin token (`ADMIN_TOKEN` env, presented as
`Authorization: Bearer …`) is usable only via headers — fine for
CLI / curl but awkward in a browser. Add a small login form on
the admin page (or `/admin/login`) with a "token" input that POSTs
to a new `/admin/login-with-token` endpoint, which:

1. Constant-time-compares the submitted token against
   `ADMIN_TOKEN`.
2. On match, mints a normal session cookie tied to the same
   synthetic admin user (`id=0`) the bearer path uses.
3. Redirects to the admin dashboard.

Rate-limit aggressively (the existing `@fastify/rate-limit` covers
this) and log every attempt.

**Why deferred.** The bearer path exists and works for the
current author flow (CLI + browser dev tools). Adding the UI
requires a route, a template change, and a test — small but
cleanest as its own commit. Also has security implications worth
attention (lockout policy, log retention) that warrant a focused
review.

**Trigger.** When the author wants to log in from a phone or a
machine where setting an Authorization header is awkward.

### Resolve knip's unused-exports queue

**Source.** `npm run knip` introduced 2026-05-08.

**What.** Knip's gate (files / dependencies / unlisted) is wired into
the pre-commit hook. The other two report categories — unused
exports and unused exported types — are NOT gated yet. As of the
knip-adoption commit they list 8 exports and 21 types that nothing
imports:

**Unused exports (8):**
- `applyOps` — src/admin/canvas.ts:50
- `bearerTokenFromHeader` — src/lib/auth-middleware.ts:36
- `sidecarPath` — src/lib/originals.ts:245
- `findUserByOAuth` — src/lib/users.ts:104
- `MAX_CAPTION_LEN`, `MAX_ALT_LEN`, `clampCaption` — src/lib/widget-helpers.ts:21-24
- `name` getter — src/widgets/figure.ts:40

**Unused exported types (21):** `DriveFile`, `CanonicalValue`,
`JobKind`, `OneDriveFile`, `IngestSource`, `ProseMark`, `ProseNode`,
`CropOp` / `ResampleOp` / `RotateOp` / `FlipOp` / `PerspectiveOp`,
`SidecarSource` / `SidecarMetadata` / `SidecarOutput` / `SidecarVariant`
(both in sidecar-types.ts AND re-exported via sidecar.ts → 4 dupes
flagged in each), `IndexEntry`. The sidecar-types vs sidecar.ts
duplication is the same pattern that drives several of the
duplicate-type-check entries; one fix solves both.

**Why deferred.** Each entry needs case-by-case judgment: drop the
export, drop the symbol entirely, or add an opt-in test that
imports it (preserving the export as a public API). 29 small fixes
is its own commit — better as focused cleanup than slipped into
unrelated work.

**Trigger.** Pick up when refactoring or when extending one of the
listed modules. After the queue empties, drop `--include
files,dependencies,unlisted` from the pre-commit gate so knip runs
the full report and the unused-export check becomes load-bearing.

### Resolve the duplicate-type-check allowlist

**Source.** Companion to `scripts/check-duplicate-types.ts` introduced
2026-05-08.

**What.** The duplicate-type checker maintains an allowlist of 15
known-existing dupes so it could ship without forcing a sweeping
cross-codebase rename. Each entry is a target for incremental
cleanup:

- **Production (8):** `CallbackQuery` + `ImportBody` (gdrive vs
  onedrive — extract to `src/routes/integrations-shared.ts`); `Op`
  (canvas-math should rename to `OpInput`); `Point` (main.ts should
  import the canonical readonly version from canvas-math);
  `DirectiveNode` (content.ts vs widgets.ts — re-export from one);
  `UploadResponse` (test should import the route's response type);
  `Sub` (rename per-CLI: `ImportWpSub`, `UserSub`); `CliOpts`
  (rename per-CLI: `MigrateFiguresCliOpts`, `ResetCliOpts`).
- **Test-only (7):** `JobRow` (test should import prod type);
  `AccessBody` / `StatusBody` / `ErrorBody` / `ErrorResponse` /
  `StubOpts` / `StubTokens` (extract to
  `test/helpers/oauth-fixtures.ts`).

**Why deferred.** Sweeping rename + extraction is mechanical but
touches many files. Resolving piecemeal as files are touched
naturally avoids one disruptive commit and keeps the queue moving.

**Trigger.** Each entry resolves by editing its allowlist line out
of `scripts/check-duplicate-types.ts` once the rename or extract
ships. Empty allowlist → simplify the script.

### Playwright UI testing

**Source.** User request, 2026-05-08.

**What.** The editor's UI binding code in `src/admin/main.ts`
(toolbar, attribute panel, cropper, integrations) has no
automated test coverage today — it's verifiable only by hand.
Add Playwright with a small headless suite covering the golden
paths:

- Open a post, type, save → reload → content matches
- Insert each figure shape (image / gallery / carousel / diptych /
  triptych), edit attributes, save → markdown matches expected
  directive
- Crop a single-image figure, save → sidecar ops persist
- OAuth callback (Google) lands on admin dashboard
- Login button (once the admin-token entry above ships)

Wire it to run in CI behind `npm run test:e2e` so the unit suite
stays fast (`npm test` ≈ a few seconds) and the e2e suite runs on
push / PR.

**Why deferred.** Real new infrastructure: Playwright dependency,
test database / fixture setup, CI runner, headless browser
install. Worth doing as a focused commit so the setup is readable
later. Strongly complementary to the `main.ts` refactor — UI tests
make the split safer.

**Trigger.** Land before or alongside the `main.ts` split so the
refactor has a regression net. Or first time a UI bug ships
because there was no automated check.
