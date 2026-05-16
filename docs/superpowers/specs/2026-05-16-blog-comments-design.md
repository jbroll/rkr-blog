# Blog Comments — Design Spec

**Date:** 2026-05-16
**Status:** Approved (brainstorming) — pending spec review
**Repos affected:** `rkr-blog`, `gpu-services`

## 1. Goal

Add a reader comment system to the rkr-blog platform (deployed at `rkr-blog.rkroll.com`,
canonical content seeded from the WordPress site `roll-along.rkroll.com`):

1. Anonymous readers can submit comments (WordPress-style name + email).
2. New comments are auto-published if a local LLM (Ollama on the GPU box) classifies
   them as ham; suspected spam is held in a moderation queue for the author.
3. The 37 approved comments currently on `roll-along.rkroll.com` are recovered and
   imported as normal published comments.

Non-goals: CAPTCHA, third-party comment widgets, multi-level threading beyond one
reply level, email notifications, importing WordPress spam/trash, commenter
self-service edit/delete.

## 2. Key decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Moderation flow | Auto-publish clean comments; queue Ollama-flagged suspects for human review |
| Spam pipeline | **Asynchronous** via the existing `jobs` table/worker (approach B) |
| Ollama connectivity | General token-auth'd `ProxyPass /ollama/` on `symon.rkroll.com` (gpu-services), reusable by future services |
| Spam model | `llama3.2:3b` (already pulled on the GPU box; fast, low contention) |
| WP recovery scope | Approved comments only (37), imported as normal published comments, not re-scored |
| Commenter identity | Name + email (WP-style); email required, never shown publicly; optional website |
| Threading | One level of replies (top-level + single reply level) |

## 3. Topology (context)

| Host | IP | Role |
|---|---|---|
| `rkr-blog.rkroll.com` | 72.62.80.9 | the blog (public VPS, multi-app — also hosts wicketmap) |
| `symon.rkroll.com` | 100.4.213.68 | apache token-auth reverse proxy fronting the GPU box (gpu-services repo `home/vhost.conf`) |
| GPU box (`gpu`) | 192.168.1.169 (LAN) | RTX 4070 12 GB; Ollama at `192.168.1.169:11434`, LAN-only, no auth |
| `roll-along.rkroll.com` | 192.241.136.225 | source WordPress site; 37 approved comments via public `/wp-json/wp/v2/comments` |

The blog VPS cannot reach the LAN Ollama directly; all access goes through symon's
public IP with the existing apache token.

## 4. Architecture / components

### rkr-blog (blog VPS)

- **Migration `src/migrations/004_comments.sql`** — `comments` table (§5).
- **Public routes** — `POST /:slug/comments` (submit), comment list rendered inline
  on the post page (no separate GET endpoint required for v1).
- **`SpamClassifier` module** (`src/lib/spam-classifier.ts`) — calls Ollama via
  symon, parses a strict JSON verdict, fully unit-testable with mocked HTTP.
- **`classify` job handler** — new `kind:'classify'` in the existing job worker
  (the worker that already processes `kind:'render'` image jobs).
- **Comment rendering** — in `src/templates/post.ts` (list + progressively-enhanced
  form).
- **Moderation UI** — a "Comments" view in the existing OAuth-gated admin SPA.
- **`bin/site-admin import-wp-comments <wp-base-url>`** — one-shot, idempotent
  recovery command.

New `secrets.env` config:

```
OLLAMA_BASE_URL=https://symon.rkroll.com/ollama
OLLAMA_TOKEN=<symon apache token>
SPAM_MODEL=llama3.2:3b
SPAM_TIMEOUT_MS=8000
SPAM_MAX_ATTEMPTS=3
```

`secrets.env.example` updated with placeholders.

### gpu-services (symon vhost)

Add inside the existing `:443` token-auth-wrapped vhost in `home/vhost.conf`:

```apache
ProxyPass        /ollama/ http://192.168.1.169:11434/
ProxyPassReverse /ollama/ http://192.168.1.169:11434/
```

It inherits `Include /etc/apache-token-auth/apache/token-auth.conf`, so every
`/ollama/*` request requires the symon token. General-purpose; the blog only calls
`/ollama/api/generate`. Deployed via the existing gpu-services `deploy.sh` flow.

**Why the LAN IP, not `localhost`:** The GPU box runs Void Linux + runit; the
Ollama service script (`/etc/sv/ollama/run`) pins `export
OLLAMA_HOST=192.168.1.169:11434`. Ollama binds exactly that one address (not
`0.0.0.0`, not loopback), so `localhost:11434` answers nothing. The `ProxyPass`
therefore targets `192.168.1.169:11434` directly — apache runs on the same box and
reaches it fine. This deliberately leaves the Ollama service untouched so existing
LAN consumers keep working (changing `OLLAMA_HOST` to `127.0.0.1` would break them;
`0.0.0.0` would needlessly widen the bind). No Ollama service change is required;
the implementation plan only verifies reachability from apache.

## 5. Data model

`src/migrations/004_comments.sql`, single table:

```sql
CREATE TABLE comments (
  id             INTEGER PRIMARY KEY,
  post_id        INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_id      INTEGER NULL REFERENCES comments(id) ON DELETE CASCADE,
  wp_comment_id  INTEGER NULL UNIQUE,            -- set for source='wp-import' dedupe
  author_name    TEXT NOT NULL,
  author_email   TEXT NOT NULL,                  -- never passed to public templates
  author_url     TEXT NULL,
  body           TEXT NOT NULL,                  -- stored raw, escaped on render
  status         TEXT NOT NULL
                   CHECK(status IN ('pending','published','queued','rejected')),
  source         TEXT NOT NULL DEFAULT 'web'
                   CHECK(source IN ('web','wp-import')),
  spam_score     REAL NULL,                      -- 0..1 from classifier
  spam_reason    TEXT NULL,                      -- short model rationale, audit only
  ip             TEXT NULL,                      -- submission IP, moderation only
  created_at     TEXT NOT NULL,                  -- WP original date on import
  classified_at  TEXT NULL
);
CREATE INDEX idx_comments_post   ON comments(post_id, status, created_at);
CREATE INDEX idx_comments_status ON comments(status);
CREATE INDEX idx_comments_parent ON comments(parent_id);
```

Status lifecycle:

- `pending` → (classify job) → `published` (ham) | `queued` (spam or classify failure)
- Moderation actions: `queued` → `published` | `rejected`
- WP import inserts directly as `published`, `source='wp-import'`, no classification.

One-level threading enforced in code: a comment with `parent_id` set must reference a
comment whose `parent_id IS NULL` and same `post_id`; deeper nesting is flattened to
top-level on import and rejected on submission.

## 6. Submission + spam pipeline flow

1. `POST /:slug/comments` (HTML form or fetch). Server validates: required
   name/email/body present; length caps; valid post slug; optional `parent_id`
   belongs to the same post and is top-level. Anti-abuse checks (§8) applied here.
2. Insert row `status='pending'`. Enqueue `jobs` row `kind:'classify'`,
   `ref=comment.id`. Respond fast: 303 redirect back to the post anchored to a
   "your comment will appear shortly" notice (no-JS path); JSON + inline notice when
   submitted via fetch.
3. Worker picks up the `classify` job → `SpamClassifier.classify({name,email,url,
   body})` → `POST {OLLAMA_BASE_URL}/api/generate` with `model=$SPAM_MODEL`,
   pinned prompt, `format:'json'`, `stream:false`, bearer token, `SPAM_TIMEOUT_MS`.
4. Model returns `{verdict:"ham"|"spam", score:0..1, reason:string}`. Persist
   `spam_score`, `spam_reason`, `classified_at`. `ham` → `status='published'`;
   `spam` → `status='queued'` (held for review, never silently dropped).
5. Failure path (timeout / proxy down / unparseable): job retries up to
   `SPAM_MAX_ATTEMPTS`; on final failure `status='queued'` (fail-safe — unscored
   comments never auto-publish).

The classifier prompt is pinned in-repo, requests JSON only, and treats link-heavy,
gibberish, or promotional text as spam.

## 7. WordPress comment recovery

`bin/site-admin import-wp-comments <wp-base-url>` — one-shot, re-runnable:

1. Page `GET /wp-json/wp/v2/comments?per_page=100&page=N` (public API → 37 approved
   comments; `X-WP-Total` drives paging).
2. Map WP `post` ID → local post, reusing the existing WP post-import ID→slug
   mapping. Comments whose post is not yet imported are skipped with a warning.
3. Map WP comment `id`/`parent` → local `parent_id`; flatten anything deeper than
   one level to top-level.
4. Insert `status='published'`, `source='wp-import'`, `created_at`=WP `date`,
   `author_name`/`author_url` from WP, `author_email` = sentinel
   (`imported@roll-along`, never displayed; the public API does not expose commenter
   emails), `wp_comment_id`=WP id.
5. Idempotent via `wp_comment_id UNIQUE` — re-running skips already-imported
   comments.

## 8. Anti-abuse defaults (before Ollama runs)

Cheap pre-filters so the GPU is not the only defense:

- Hidden honeypot field — if filled, silent reject (`status='rejected'`, no job).
- Minimum render-to-submit time — too-fast submits → `queued`.
- Per-IP rate limit via the existing rate-limit plugin: 5 comments / 10 min / IP.
- Hard length caps (name, email, url, body).
- Max-links heuristic — obvious link spam pre-marked `queued` without an Ollama call.
- No CAPTCHA (keeps CSP strict and reader friction low).

## 9. Display & moderation UI

**Public** (`src/templates/post.ts`): below the post, render `published` comments
for that post oldest-first, replies indented one level under their parent. Each:
author name (linked to `author_url` with `rel="nofollow ugc noopener"` if present),
date, escaped body. Below the list: a progressively-enhanced comment form (works
without JS via the 303 redirect; fetch-based with inline notice when JS is on). A
"Reply" affordance sets `parent_id`. CSP stays strict — no third-party scripts;
`author_email` is never emitted to templates.

**Admin SPA**: a "Comments" view listing `queued` first (showing
`spam_score`/`spam_reason`), then recent `published`. Actions: Approve / Reject /
Delete. Reuses existing OAuth-gated admin auth and UI patterns.

## 10. Testing

- **Unit:** `SpamClassifier` with mocked Ollama HTTP (ham, spam, malformed JSON,
  timeout); submission validation; `parent_id` rules; honeypot / rate-limit.
- **Migration:** `004_comments.sql` applies cleanly; constraints enforced.
- **WP recovery:** mocked WP REST fixtures — paging, parent flattening, idempotent
  re-run, missing-post skip.
- **Integration** (project headless workflow-test pattern): submit → `pending` →
  run classify job with stubbed classifier → assert `published` vs `queued`;
  moderation transitions.
- **E2E** (existing Playwright harness): submit a comment and see the "appears
  shortly" notice; admin approves a queued comment and it appears publicly.

## 11. Out of scope / deferred

Email notifications on new/queued comments; commenter edit/delete; importing WP
spam/trash/pending; multi-level threading; CAPTCHA; per-commenter accounts.
