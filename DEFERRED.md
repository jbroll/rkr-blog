# Deferred items

Things we know about and have decided not to fix yet. Each entry includes:
- **Source**: the review or audit that surfaced it
- **What**: the issue
- **Why deferred**: the deliberate reasoning
- **Trigger**: the condition that should bring this back to the top of the queue

When you fix one, delete the entry. When something gets worse than expected,
promote it. Newly-discovered work goes here, not into commit messages, so
the queue is searchable.

## ::figure editor: per-cell cropper for multi-image figures

**Source.** Spec.md §9 unification follow-up. Most of the toolbar
UX refresh that lived here previously was implemented (adapter
helpers deleted, toolbar collapsed to Image/Gallery, attribute
panel unified to read/write figure attrs directly, image-edit
pipeline shows when ids count is 1).

**What.** What remains: when a figure has more than one image,
there's no UI for cropping or applying ops to a *selected cell*.
The image-edit section is hidden in multi mode; ops on a
multi-image figure currently aren't expressible from the editor.

**Why deferred.** Requires per-instance cell selection in the
editor's figure preview (a real interaction surface) plus a
data-model decision: do per-cell ops live on the sidecar (one
ops list per id) or on the directive? Sidecar.ops is the existing
shape, so per-cell ops would naturally update the sidecar of the
specific id. The cell-selection UI is the missing piece.

**Trigger.** First time an author wants to crop one image inside
a multi-image figure.

## Slice main.ts mount() into per-panel mounts

**What.** The 7-module split tracked here previously landed in
2026-05-09 (`dom.ts`, `upload.ts`, `canvas-loaders.ts`,
`image-edit.ts`, `cropper-modal.ts`, `perspective-modal.ts`,
`save.ts`, plus `integrations/{gdrive,onedrive}.ts`). main.ts is
now 709 lines: FigureNode + a single `mount()` orchestrator that
wires every panel section to the editor.

The remaining oversize is structural — `mount()` constructs and
binds the toolbar, the figure-attrs panel, the image-edit pipeline
controls, the per-image dirty-state subscriptions, the file-input,
and the integrations buttons in one closure. Slicing it requires
either extracting closure-scoped helpers behind explicit return
shapes (each panel owning its own `mountX(deps)` function) or
threading the editor + setStatus + state stores through a
parameter object.

**Why deferred.** The natural-cut extractions (those with cleanly
exportable boundaries) are done. Further reduction means deciding
on a DI contract for the closure-scoped helpers; that's a design
choice better made when a real motivating change drives it (e.g.
adding a new panel, or replacing TipTap), not as a size-hook tax.

**Trigger.** When a feature touching the editor wants per-panel
isolation, OR when the size hook is tightened to fail-on-existing
(the entry below).

## Tighten the per-file size hook to fail-on-existing

**What.** `.githooks/pre-commit` already enforces the 500-line
ceiling for new files in production source (`src/`, `bin/`) and
rejects any growth in already-oversized files (warn-on-existing).
Tests are exempt from the size check — coverage growth is a feature.
After the 2026-05-09 main.ts split, only `src/admin/main.ts` (709)
is still over the limit; once it lands under 500, the hook should
be tightened so the warn-on-existing branch becomes a FAIL.

**Why deferred.** main.ts (709) is the last warn-on-existing
production file. Flipping the gate before main.ts is split below
500 would block every commit that touches main.ts.

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

### Refactor production source files to under 500 lines

**Source.** User request, 2026-05-08; companion to the size-hook
entries above.

**Status (2026-05-09).** All 4 originals refactored to under 1k lines:

| File | Was | Now | Notes |
|---|---|---|---|
| `src/admin/main.ts` | 1900 → 1747 | 709 | 7 modules extracted; see "Slice main.ts mount() into per-panel mounts" |
| `src/routes/admin.ts` | 1026 | 395 | split into 4 modules — see entry below |
| `src/lib/wp-import.ts` | 580 → 511 | 349 | extracted wp-import-emit.ts |
| `src/widgets/figure.ts` | 512 → 507 | 416 | extracted figure-attrs.ts |

The admin.ts split landed across 4 commits:
- `routes/admin-ops-validation.ts` (validateOps + constants/types)
- `routes/admin-import-url.ts` (POST /admin/import/url)
- `routes/admin-sidecar-edit.ts` (POST /admin/sidecar/:id/{ops,bake})
- `routes/admin-image-lookup.ts` (GET /admin/preview/:id, /admin/original/:id, /admin/sidecar/:id/meta + cache)

**Why deferred (main.ts only).** Mechanical but extensive; benefits from
in-browser smoke testing for the editor pieces and from being
sequenced (smaller files first, build confidence).

**Trigger.** Tackle in a dedicated refactor sprint, or piecemeal
whenever a feature touches one of these files.

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

Outstanding editor-flow coverage:

- Open an existing post, type, save → reload → content matches
- Crop a single-image figure, save → sidecar ops persist
- OAuth callback (Google) lands on admin dashboard (needs an inject
  hook to stub the exchange/verifier inside the long-running
  webServer; the unit suite already covers the data layer)

**Why deferred.** The remaining cases need either richer fixture
data (an existing-post round-trip needs a seeded post on disk) or
an OAuth stub hook in the long-running webServer. The first save
flow shipping in `editor-flow.spec.ts` already gives the `main.ts`
split work a regression net for the toolbar / attribute panel.

**Trigger.** Add cases as fixture infrastructure grows, or the
first time a UI bug ships uncaught.
