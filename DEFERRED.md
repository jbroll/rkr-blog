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

### 9a — c8 ignore vs `Widget.fallback` optionality
**What.** `src/lib/widgets.ts` types `Widget.fallback` as optional, but
`/admin/preview/:id` asserts at runtime that imageWidget always has one
(with a c8 ignore on the guard). Either drop the optional in the interface
(image is the only fallback consumer) or remove the c8 ignore so coverage
tracks reality.

**Why deferred.** Judgment call; the runtime guard is correct defense and
the c8 ignore documents why coverage doesn't reach it. Other widget types
might legitimately not need a fallback in the future.

**Trigger.** When we add a new widget that does need a fallback, or when
someone asks why the optional is there.

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

### 9b — Carousel autoplay UI feedback
**What.** The autoplay input has `max="60"` (advisory only). With the clamp
fix in `emitMultiImage`, an out-of-range value silently clamps on emit; the
author gets no UI signal that 999 became 60.

**Why deferred.** Low priority — typing 999 is unusual; the published page
will look correct.

**Trigger.** First user confusion. Or when we add other clamped numeric
inputs and want a shared "out-of-range" indicator.

### 9b — Comment density
**What.** Some new comments in `src/admin/main.ts` (e.g. JSDoc on `uploadMany`/
`pickMany`) are descriptive rather than non-obvious — borderline against
"no comments unless WHY is non-obvious".

**Why deferred.** Subjective. Easy to trim during the next adjacent edit.

**Trigger.** Next time those functions are touched.

## Step 7 follow-ups

### OneDrive picker integration
**What.** Spec §17 listed Dropbox/OneDrive/Drive as the import targets.
Drive shipped in Step 7c2; OneDrive was deferred pending the user
registering an MS Entra app for OAuth. Dropbox was dropped from scope.

**Why deferred.** Blocked on user-side credential registration.

**Trigger.** When the user registers an MS Entra app and provides
`MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`.

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

### Other crop ops (rotate, flip, resample) lack UI
**What.** The render pipeline supports `resample` and `rotate` ops; the
editor only emits `crop`. validateOps in src/routes/admin.ts also only
accepts `crop`.

**Why deferred.** Crop is the 80% case; rotate/resample need their own
UIs.

**Trigger.** When an author wants to rotate or resize without leaving
the editor.

## Step 8 follow-up

### Per-image alt text in galleries (container directive form)
**What.** Galleries/carousels/diptychs all hard-code `alt=""` (decorative
default). For galleries that aren't decorative, there's no path for
per-image alt text. Spec §12 mentions a future container directive form
(`:::gallery{...}` enclosing `::image{...}` children) that would address this.

**Why deferred.** The leaf-directive MVP shipped first; the container form
is a real parser+renderer change.

**Trigger.** Authoring a gallery that needs accessible per-image alt.
