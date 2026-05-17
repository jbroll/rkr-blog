# Comment Email Notifications — Design

**Date:** 2026-05-17
**Status:** Approved (pending spec review)

## Goal

Email the site owner when a reader comment is successfully posted —
specifically, when the spam classifier verdicts a comment as **ham**
and it auto-publishes. Manual admin-approve does **not** notify (that
is the owner's own action). Spam / moderation-queued comments do not
notify.

Single known recipient (the owner). No reply-to-commenter
notifications.

## Non-goals (YAGNI)

- HTML email (plain text only — no escaping/injection surface)
- Unsubscribe handling
- Per-post or per-author notification toggles
- Batching / digest
- Notification on manual admin-approve of a queued comment
- Notification on submission (pending) — only on the ham→published
  transition

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
  not `published`, return quietly (defensive, mirrors
  `classify-handler.ts:44`).
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

### `src/lib/classify-handler.ts` (modify)

On the **ham branch only**, after
`applyClassification(db, id, { status: 'published', ... })`:

```
enqueue(db, { kind: 'notify', payload: { commentId: payload.commentId } });
```

No notify on the `queued` (spam / classifier-error) branch.

### `package.json` (modify)

Add `nodemailer` to `dependencies`. (Add `@types/nodemailer` to
devDependencies if not bundled.)

## Data flow

```
POST /:slug/comments
  → insertWebComment (pending)
  → enqueue classify job
       → classify-handler: verdict ham
            → applyClassification(published)
            → enqueue notify job
                 → notify-handler: load comment + post
                      → mailer.sendMail → SMTP
```

The notify job is a separate queue unit. SMTP latency/failure never
touches classification, and the single-worker loop serializes sends
naturally.

## Configuration (secrets.env)

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

- **Subject:** `New comment on "<post title>" by <author name>`
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
- **`notify-handler.ts`**: seed comment + post, run with a fake
  mailer, assert `to` / `subject` / `text` content (including the
  comment + admin links). Assert silent return on missing comment and
  on non-`published` status.
- **`classify-handler.ts`**: extend the existing test — assert a
  `notify` job is enqueued on the ham verdict and **not** on the spam
  verdict.

## Conventions

ES modules, kebab-case filenames, no top-level side effects (lazy env
reads), production source under the 500-line cap. Follows the existing
`classify-handler.ts` / `envClassifier()` factory + fail-safe
patterns. See `docs/developer-quickstart.md §4`.
