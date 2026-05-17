# Comment Email Notifications — Design

**Date:** 2026-05-17
**Status:** Revised 2026-05-17 — notification level is now an
operator-selectable Settings value (was hardcoded ham-only).

> Line/path anchors below (`server.ts:228/:245`,
> `classify-handler.ts:42/44`) were written against an older `main`
> and have since drifted (~32 commits; e.g. reindex moved to
> `lib/post-index.ts`). The approach holds; re-verify exact anchors
> at plan time.

## Goal

Email the site owner about reader comments, at a verbosity the
operator chooses in Settings. The classifier flips a submitted
comment `pending → published` (ham) or `pending → queued` (spam /
classifier failure / too-fast fill). The owner picks which of those
transitions generate mail:

- **off** — never email (explicit disable, independent of SMTP).
- **ham** — only when a comment auto-publishes (ham). *Default.*
- **queued** — only when a comment lands in the moderation queue
  (the items actually needing the owner's action).
- **all** — both transitions.

Manual admin-approve never notifies (the owner's own action). Single
known recipient (the owner). No reply-to-commenter notifications.

## Non-goals (YAGNI)

- HTML email (plain text only — no escaping/injection surface)
- Unsubscribe handling
- Per-post or per-author notification toggles (one global level)
- Batching / digest
- Notification on manual admin-approve of a queued comment
- Notification on submission while still `pending` (only the
  resolved `published` / `queued` transitions notify)

## Architecture & components

### `src/lib/mailer.ts` (new)

Thin nodemailer wrapper.

- `sendMail({ to, subject, text }): Promise<{ sent: boolean }>`
- Reads SMTP config from env **lazily** (mirrors `envClassifier()` in
  `classify-handler.ts` — importing the module has no side effects).
- If `SMTP_HOST` or `NOTIFY_TO` is unset → **no-op returning
  `{ sent: false }`**, with a one-shot stderr warning. This mirrors
  the existing fail-safe patterns (`themeName()` fallback,
  classifier-down → moderation). Feature absent, never crashes.
- Catches all transport errors, logs to stderr, returns
  `{ sent: false }`. **Never throws.**
- Transport is injectable for tests (no real SMTP in the suite).

### `src/lib/notify-handler.ts` (new)

- `makeNotifyHandler(mailer)` returns a
  `JobHandler<{ commentId: number }>`.
- Reads `ctx.db` (the worker populates `ctx: { siteRoot, db }` — see
  `server.ts:228`). Throws if `ctx.db` is missing (same shape as
  `classify-handler.ts:42`).
- Loads the comment via `getCommentById`. If missing, or status is
  neither `published` nor `queued`, return quietly (defensive,
  mirrors `classify-handler.ts:44`). The level gate already happened
  at enqueue time (see classify-handler) — the handler trusts the
  job exists and just sends; it branches subject/body on the
  comment's status (`published` vs `queued`).
- Loads the post slug + title (join `posts` on `comment.post_id`; add
  a small helper to `comments.ts`, e.g. `getPostMetaById`, alongside
  the existing `getPostIdBySlug`).
- Builds the email and calls `mailer.sendMail(...)`. The handler
  completes normally regardless of `{ sent }` — a failed email must
  not wedge the queue (`jobs.ts` has no auto-retry; a thrown handler
  would sit `failed` forever).

### `src/lib/jobs.ts` (modify)

- Add `'notify'` to the `JobKind` union.
- Add `notify: makeNotifyHandler(envMailer())` to `DEFAULT_HANDLERS`.
- `envMailer()` is exported from `mailer.ts` (the env-backed factory
  lives with the transport it configures), following the
  `envClassifier()` precedent in `classify-handler.ts`.

### Notification level (Settings) — `config.ts` + admin-settings (modify)

Persisted, operator-edited, **not a secret**. Mirrors the existing
`postTeaser` / `teaserWords` / `bannerAboveHeader` plumbing added
this session:

- `SiteConfig` + `PersistedSiteConfig`: add
  `commentNotify?: 'off' | 'ham' | 'queued' | 'all'`.
- `pickPersistedFields`: accept only that enum (unknown/missing →
  treated as the default).
- `siteConfig()`: surface it; **default `'ham'`** (preserves the
  original spec's behavior; only matters once SMTP is configured).
- `src/templates/admin-settings.ts`: a `<select name="commentNotify">`
  in the Comments/Posts section — options Off / Ham (auto-published) /
  Queued (needs moderation) / Any — pre-selected from persisted.
- `src/routes/admin-settings.ts`: parse `commentNotify` (validate
  against the enum, else ignore), include in `writePersistedSiteConfig`.

### `src/lib/classify-handler.ts` (modify)

Read the level via `siteConfig().commentNotify` (default `'ham'`).
Gate the enqueue at the transition so no dead `notify` jobs are
created:

```
const lvl = siteConfig().commentNotify ?? 'ham';
// ham branch, after applyClassification(..., status:'published'):
if (lvl === 'ham' || lvl === 'all')
  enqueue(db, { kind: 'notify', payload: { commentId } });
// queued branch (spam / classifier error), after status:'queued':
if (lvl === 'queued' || lvl === 'all')
  enqueue(db, { kind: 'notify', payload: { commentId } });
```

`lvl === 'off'` enqueues nothing on either branch.

### `src/routes/public-comments.ts` (modify)

The too-fast-fill path inserts straight to `queued`, skipping the
classify job. Apply the same gate there: if
`lvl === 'queued' || lvl === 'all'`, `enqueue` a `notify` job for the
new comment id (so honeypot/timing rejections still alert when the
operator wants queued notifications).

### `package.json` (modify)

Add `nodemailer` to `dependencies`. (Add `@types/nodemailer` to
devDependencies if not bundled.)

## Data flow

```
POST /:slug/comments
  → insertWebComment (pending)
  ├─ too-fast fill → status=queued
  │     → if level∈{queued,all}: enqueue notify
  └─ enqueue classify job
        → classify-handler (reads siteConfig().commentNotify):
            ham   → applyClassification(published)
                     → if level∈{ham,all}:    enqueue notify
            spam/ → applyClassification(queued)
            error    → if level∈{queued,all}: enqueue notify
                          → notify-handler: load comment + post
                               → subject/body per status
                               → mailer.sendMail → SMTP
```

The notify job is a separate queue unit. SMTP latency/failure never
touches classification, and the single-worker loop serializes sends
naturally. The level is read at enqueue time, so changing it in
Settings affects only subsequent comments (already-enqueued jobs
still send).

## Configuration

Two independent layers:

1. **Transport** — SMTP creds in `secrets.env` (below). Secret.
   Unset → mailer no-ops regardless of level.
2. **Level** — `commentNotify` in the persisted site config
   (`config/site.json`), edited at `/admin/settings`. **Not** a
   secret. `off` → no mail even when SMTP is fully configured.

Both gates must pass for an email to send: a configured transport
**and** a level that includes the comment's transition.

### SMTP transport (`secrets.env`)

New environment variables, added to `secrets.env.example` with
explanatory comments:

| Var         | Required | Default | Notes                                  |
|-------------|----------|---------|----------------------------------------|
| `SMTP_HOST` | yes\*    | —       | Unset → mailer no-ops                  |
| `SMTP_PORT` | no       | `587`   |                                        |
| `SMTP_USER` | no       | —       | Omit for unauthenticated relays        |
| `SMTP_PASS` | no       | —       |                                        |
| `SMTP_FROM` | no       | `SMTP_USER` | From: header                        |
| `NOTIFY_TO` | yes\*    | —       | Owner address. Unset → mailer no-ops   |

\* "Required" for the feature to be active; absence is a clean no-op,
not an error. The site runs normally without mail configured.

## Email content (plain text)

- **Subject** (varies by status):
  - published: `New comment on "<post title>" by <author name>`
  - queued: `[moderation] Held comment on "<post title>" by <author name>`
- **Body** (plain text, no HTML):
  - Author name and email
  - Post title
  - Comment body (verbatim)
  - Link to the comment:
    `${PUBLIC_BASE_URL}/<slug>#comment-<id>`
  - Link to moderation: `${PUBLIC_BASE_URL}/admin/comments`

`PUBLIC_BASE_URL` is already a required env var (`server.ts:245`).
All interpolated values are plain text — no HTML means no escaping or
injection surface.

## Error handling

| Failure                         | Behavior                                    |
|---------------------------------|---------------------------------------------|
| SMTP not configured             | mailer no-ops, one-shot stderr warn         |
| SMTP transport error            | caught, logged, `{ sent: false }`, job `done` |
| Comment missing / wrong status  | handler returns quietly, job `done`         |
| `ctx.db` missing                | handler throws (programmer error, like classify) |

Principle: one missed notification is acceptable; a stuck queue or a
crashed site is not.

## Testing

- **`mailer.ts`**: no-op-when-unconfigured path; configured path with
  an injected fake transport asserting the message payload. No real
  SMTP.
- **`notify-handler.ts`**: seed comment + post, fake mailer; assert
  `to` / `subject` / `text` for **both** a `published` and a
  `queued` comment (subject differs). Assert silent return on
  missing comment and on a status that is neither.
- **`config.ts`**: `commentNotify` round-trips through
  `writePersistedSiteConfig` / `pickPersistedFields`; unknown value
  falls back to the `'ham'` default; mirrors the existing
  `teaserWords` config test.
- **`classify-handler.ts`**: extend the existing test — for each
  level (`off`/`ham`/`queued`/`all`) assert `notify` is enqueued on
  the ham branch and/or the spam branch exactly per the matrix
  (e.g. `queued` → notify on spam, none on ham; `off` → never).
- **`public-comments.ts`**: the too-fast-fill path enqueues `notify`
  iff level ∈ {queued, all}.
- **admin-settings**: the `<select>` renders the persisted value
  selected; POST persists a valid enum and ignores an invalid one
  (mirrors the `teaserWords` route test).

## Conventions

ES modules, kebab-case filenames, no top-level side effects (lazy env
reads), production source under the 500-line cap. Follows the existing
`classify-handler.ts` / `envClassifier()` factory + fail-safe
patterns. See `docs/developer-quickstart.md §4`.
