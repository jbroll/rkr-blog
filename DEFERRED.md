# Deferred items

Things we know about and have decided not to fix yet. Each entry includes:
- **Source**: the review or audit that surfaced it
- **What**: the issue
- **Why deferred**: the deliberate reasoning
- **Trigger**: the condition that should bring this back to the top of the queue

When you fix one, delete the entry. When something gets worse than expected,
promote it. Newly-discovered work goes here, not into commit messages, so
the queue is searchable.

## ::figure migration: editor toolbar refactor + legacy widget removal

**Source.** Spec.md §9 migration plan, steps 6-7. Phases 1-5 of the
unification are landed (commits leading up to 2026-05-08); phase 6
(`migrate-figures` rewriter) ships the operator-side migration tool.
Step 5 lands the spec's target render path (`::figure`); steps 6-7
are cleanup that depends on a real editor refactor.

**What.** Two pieces remain:

  6. **Editor toolbar UI**: the existing toolbar has insert flows for
     image / gallery / carousel / diptych / triptych — five buttons,
     each producing the corresponding legacy ProseMirror node. Need to
     collapse these into one "insert figure" flow with an attribute
     panel for matrix / justify / aspect / fit / per-image alts &
     captions. Until done, the editor's "insert image" still emits
     ::image markdown that the public widget renderer maps via the
     legacy paths.
  7. **Legacy widget deletion**: once step 6 lands and the operator
     has run `site-admin migrate-figures --write`, we can:
       - delete src/widgets/{image,diptych,gallery,carousel}.ts
       - drop their imports + `widgets.register()` calls in
         src/routes/public.ts
       - delete the legacy emit/parse cases in src/lib/prose-markdown.ts
       - delete the legacy ProseMirror node types in src/admin/main.ts
       - delete test/widgets/{image,diptych,gallery,carousel}.test.ts
       - shrink test/lib/widget-fallback-alignment.test.ts to one widget
       - drop unused .rkr-pos-* / .rkr-gallery-* / etc. CSS rules
         (keep .rkr-carousel-* since the figure widget reuses them)

**Why deferred.** Step 6 is genuine UI work that benefits from a
browser to test iteratively (insert flow, attribute panel UX, slot
management). Step 7 has a chicken-and-egg with step 6 — deleting
server-side widgets while the editor still produces legacy directives
would break new authoring. Doing both in one big commit is risky and
hard to review.

The migration is **functionally complete** without these steps: the
WP importer already emits `::figure`; `migrate-figures` rewrites
existing content; the unified widget is the canonical render path.
The legacy widgets continue to work in the meantime so old content
and editor-authored posts render correctly.

**Trigger.** Take this on when there's a real iteration loop
available for the editor — i.e. when the operator can interactively
test the new insert flow + attribute panel against real photos. Both
steps land in one commit pair (editor refactor + legacy delete).

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
