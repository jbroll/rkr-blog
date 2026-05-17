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

## Editor & figures

- **`src/admin/main.ts` over the 500-line gate (507)** — the
  now-enforced pre-commit size gate **blocks any commit that stages
  `main.ts`** until it is split (per-panel `mountX(deps)` extraction:
  figure-attrs / image-edit / cell-selection). A real, active blocker
  for editor changes that touch it (e.g. per-cell persistence below).
  _Revisit when:_ the next change that must edit `main.ts` — it
  already blocks.
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

- **Public-side offline status indicator** — no reader signal when a
  cached copy is served. _Revisit when:_ a reader "is this cached?"
  bug, or a push to full offline-first PWA.
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

- **Post-deploy "30s to first page"** — no deploy health-gate; SW
  navigation SWR has no network timeout (worst case = login flush).
  _Revisit when:_ reported again, deploys get more frequent, or
  multi-author/higher traffic.
- **SW stale-while-revalidate vs fresh comments** — a SW-cached post
  page hides a newly-approved comment until revalidation. _Revisit
  when:_ readers report missing comments without a hard refresh, or
  comment-approval UX work.
- **Teaser top-post sync `fs.readFileSync`** — blocking read on the
  anon `GET /` teaser path (mirrors the `_site-banner.md` read).
  _Revisit when:_ the homepage sees bot/cache-miss traffic, or the
  banner read is converted to async (do both together).

## Code quality

- **gdrive ↔ onedrive structural duplication** — ~150 cloned LOC; two
  parallel modules vs one Provider interface. _Revisit when:_ a third
  integration (Dropbox/iCloud) lands.

## Comments (blog-comments spec §11)

- **Email notifications on new/queued comments** — _revisit when:_ an
  email sender exists and the author wants async moderation alerts.
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
- **Flake: `editor-flow.spec.ts:442`** — crop-save thumb occasionally
  falls back to `/admin/preview` under suite load. _Revisit when:_ a
  "crops disappear after save" report, or an instrumented
  console.error run.
