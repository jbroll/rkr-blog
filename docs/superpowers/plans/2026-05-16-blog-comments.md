# Blog Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reader comments to rkr-blog: anonymous WP-style submission, asynchronous Ollama spam triage (auto-publish ham, queue suspects), one-level threading, a server-rendered moderation page, and recovery of the 37 approved comments from `roll-along.rkroll.com`.

**Architecture:** Comments live in a new `comments` SQLite table (migration `004`). Submission inserts a `pending` row and enqueues a `classify` job on the existing `jobs` table. The in-process worker (already running in `server.ts`) runs a new `classify` handler that calls `src/lib/spam-classifier.ts` (HTTP → token-auth'd Ollama proxy on `symon.rkroll.com`); `ham` → `published`, `spam`/failure → `queued`. Public post pages render published comments + a progressively-enhanced form. A separate `gpu-services` change adds one `ProxyPass` to expose Ollama behind the existing apache token auth.

**Tech Stack:** Node 22 (`--experimental-strip-types`), Fastify, `node:sqlite` via `src/lib/db.ts`, `node:test` + `node:assert/strict`, template-literal HTML, c8 coverage (≥90% lines / 75% branches / 90% functions on `src/**`, `src/admin/**` excluded).

**Conventions (read once before starting):**
- ES modules, kebab-case filenames, no top-level side effects, `.ts` import specifiers.
- Production source files (`src/`, `bin/`) have a hard 500-line cap; tests are exempt. This is why route logic goes in focused new files, not appended to `public.ts`.
- Run one test file with:
  `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/<path>.test.ts`
- Full gate before declaring done: `npm run check` (typecheck + biome + c8 coverage) then `npm run knip:gate` and `npm run circular`.
- The pre-commit hook runs the full gauntlet. Do not use `--no-verify` unless a stated, file-scoped reason applies (e.g. a docs-only commit blocked by unrelated pre-existing breakage).
- Commit after every task with the message shown in its final step.

**Branch:** Work on `feature/blog-comments` (already created off the WIP branch; the spec lives at `docs/superpowers/specs/2026-05-16-blog-comments-design.md`).

---

## File Structure

**Created (rkr-blog):**
- `src/migrations/004_comments.sql` — comments table.
- `src/lib/comments.ts` — all comment DB access (insert, get, list, status transitions, imported insert). One responsibility: persistence.
- `src/lib/spam-classifier.ts` — pure HTTP client to the Ollama proxy; injectable fetcher; bounded retries; timeout. No DB.
- `src/lib/classify-handler.ts` — the `classify` job handler: glue between `comments.ts` and `spam-classifier.ts`. Imported by `jobs.ts`.
- `src/templates/comments.ts` — `renderCommentList()` + `renderCommentForm()` (shared by public post page).
- `src/templates/admin-comments.ts` — server-rendered moderation page.
- `src/routes/public-comments.ts` — `POST /:slug/comments` registration.
- `src/routes/admin-comments.ts` — `/admin/comments` list + approve/reject/delete.
- `src/cli/import-wp-comments.ts` — one-shot, idempotent WP comment recovery command.
- Test files mirroring each under `test/`.

**Modified (rkr-blog):**
- `src/lib/jobs.ts` — extend `JobKind`, add `ClassifyPayload`, register `classify` in `DEFAULT_HANDLERS`.
- `src/server.ts` — pass `db` into the worker `ctx`; register a `application/x-www-form-urlencoded` body parser.
- `src/cli/render.ts` — add `db` to the drain-worker `ctx` (so a manual `site-admin render` never fails a queued `classify` job).
- `src/lib/wp-rest.ts` — add `listComments()`.
- `src/lib/wp-import-types.ts` — add `WpComment`.
- `src/routes/public.ts` — call `registerPublicCommentRoutes`; load published comments in `GET /:slug` and pass to the template.
- `src/templates/post.ts` — accept + render `commentsHtml` and the form.
- `src/routes/admin.ts` — call `registerAdminCommentsRoutes`.
- `bin/site-admin` — add `import-wp-comments` to `COMMANDS`.
- `secrets.env.example` — add Ollama config keys.

**Modified (gpu-services):**
- `home/vhost.conf` — one `ProxyPass /ollama/` block.

---

## Task 1: Migration + comment persistence library

**Files:**
- Create: `src/migrations/004_comments.sql`
- Create: `src/lib/comments.ts`
- Test: `test/lib/comments.test.ts`

- [ ] **Step 1: Write the migration**

Create `src/migrations/004_comments.sql`:

```sql
-- Reader comments. One table; one level of threading (parent_id must
-- reference a top-level comment, enforced in src/lib/comments.ts — SQLite
-- can't express "parent's parent_id IS NULL" as a CHECK). Imported WP
-- comments insert directly as 'published' with source='wp-import' and a
-- UNIQUE wp_comment_id for idempotent re-import.

CREATE TABLE comments (
  id             INTEGER PRIMARY KEY,
  post_id        INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_id      INTEGER NULL REFERENCES comments(id) ON DELETE CASCADE,
  wp_comment_id  INTEGER NULL UNIQUE,
  author_name    TEXT NOT NULL,
  author_email   TEXT NOT NULL,
  author_url     TEXT NULL,
  body           TEXT NOT NULL,
  status         TEXT NOT NULL
                   CHECK (status IN ('pending','published','queued','rejected')),
  source         TEXT NOT NULL DEFAULT 'web'
                   CHECK (source IN ('web','wp-import')),
  spam_score     REAL NULL,
  spam_reason    TEXT NULL,
  ip             TEXT NULL,
  created_at     TEXT NOT NULL,
  classified_at  TEXT NULL
);

CREATE INDEX comments_post   ON comments(post_id, status, created_at);
CREATE INDEX comments_status ON comments(status, created_at);
CREATE INDEX comments_parent ON comments(parent_id);
```

- [ ] **Step 2: Write the failing test**

Create `test/lib/comments.test.ts`:

```ts
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import {
  getCommentById,
  insertWebComment,
  listPublishedThread,
  setCommentStatus
} from '../../src/lib/comments.ts';

function setup(t: TestContext) {
  const db = open(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO posts (slug,title,status,created_at,updated_at,published_at,path)
     VALUES ('p','P','published','2026-01-01','2026-01-01','2026-01-01','content/posts/p.md')`
  ).run();
  const postId = db.prepare<{ id: number }>('SELECT id FROM posts').get()?.id as number;
  t.after(() => db.close());
  return { db, postId };
}

test('insertWebComment stores a pending row and getCommentById round-trips', (t) => {
  const { db, postId } = setup(t);
  const id = insertWebComment(db, {
    postId,
    parentId: null,
    authorName: 'Ann',
    authorEmail: 'ann@example.com',
    authorUrl: null,
    body: 'hi',
    ip: '203.0.113.4'
  });
  const row = getCommentById(db, id);
  assert.equal(row?.status, 'pending');
  assert.equal(row?.source, 'web');
  assert.equal(row?.author_name, 'Ann');
});

test('insertWebComment rejects a reply to a non-top-level comment', (t) => {
  const { db, postId } = setup(t);
  const top = insertWebComment(db, {
    postId, parentId: null, authorName: 'A', authorEmail: 'a@e.com',
    authorUrl: null, body: 'top', ip: null
  });
  const reply = insertWebComment(db, {
    postId, parentId: top, authorName: 'B', authorEmail: 'b@e.com',
    authorUrl: null, body: 'reply', ip: null
  });
  assert.throws(
    () => insertWebComment(db, {
      postId, parentId: reply, authorName: 'C', authorEmail: 'c@e.com',
      authorUrl: null, body: 'deep', ip: null
    }),
    /parent must be a top-level comment/
  );
});

test('listPublishedThread returns top-level published comments with their published replies', (t) => {
  const { db, postId } = setup(t);
  const top = insertWebComment(db, {
    postId, parentId: null, authorName: 'A', authorEmail: 'a@e.com',
    authorUrl: null, body: 'top', ip: null
  });
  setCommentStatus(db, top, 'published');
  const reply = insertWebComment(db, {
    postId, parentId: top, authorName: 'B', authorEmail: 'b@e.com',
    authorUrl: null, body: 'reply', ip: null
  });
  setCommentStatus(db, reply, 'published');
  const pending = insertWebComment(db, {
    postId, parentId: null, authorName: 'C', authorEmail: 'c@e.com',
    authorUrl: null, body: 'pending', ip: null
  });
  void pending;
  const thread = listPublishedThread(db, postId);
  assert.equal(thread.length, 1);
  assert.equal(thread[0]?.body, 'top');
  assert.equal(thread[0]?.replies.length, 1);
  assert.equal(thread[0]?.replies[0]?.body, 'reply');
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/lib/comments.test.ts`
Expected: FAIL — cannot find module `../../src/lib/comments.ts`.

- [ ] **Step 4: Implement `src/lib/comments.ts`**

```ts
// Comment persistence. The only module that issues SQL against the
// `comments` table (migration 004). One-level threading is enforced
// here: a reply's parent must itself be top-level (SQLite can't express
// that as a CHECK). Imported WP comments use insertImportedComment.

import type { Db } from './db.ts';

export type CommentStatus = 'pending' | 'published' | 'queued' | 'rejected';
export type CommentSource = 'web' | 'wp-import';

export interface CommentRow {
  id: number;
  post_id: number;
  parent_id: number | null;
  wp_comment_id: number | null;
  author_name: string;
  author_email: string;
  author_url: string | null;
  body: string;
  status: CommentStatus;
  source: CommentSource;
  spam_score: number | null;
  spam_reason: string | null;
  ip: string | null;
  created_at: string;
  classified_at: string | null;
}

export interface NewWebComment {
  postId: number;
  parentId: number | null;
  authorName: string;
  authorEmail: string;
  authorUrl: string | null;
  body: string;
  ip: string | null;
}

/** Throw if parentId is set but does not reference a top-level
 * (parent_id IS NULL) comment on the same post. */
function assertTopLevelParent(db: Db, postId: number, parentId: number): void {
  const parent = db
    .prepare<{ parent_id: number | null; post_id: number }>(
      'SELECT parent_id, post_id FROM comments WHERE id = ?'
    )
    .get(parentId);
  if (!parent || parent.post_id !== postId) {
    throw new Error('parent comment not found on this post');
  }
  if (parent.parent_id !== null) {
    throw new Error('parent must be a top-level comment');
  }
}

export function insertWebComment(db: Db, c: NewWebComment): number {
  if (c.parentId !== null) assertTopLevelParent(db, c.postId, c.parentId);
  const now = new Date().toISOString();
  const r = db
    .prepare(
      `INSERT INTO comments
         (post_id, parent_id, author_name, author_email, author_url, body,
          status, source, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 'web', ?, ?)`
    )
    .run(
      c.postId,
      c.parentId,
      c.authorName,
      c.authorEmail,
      c.authorUrl,
      c.body,
      c.ip,
      now
    );
  return r.lastInsertRowid;
}

export interface ImportedComment {
  postId: number;
  parentId: number | null;
  wpCommentId: number;
  authorName: string;
  authorUrl: string | null;
  body: string;
  createdAt: string;
}

/** Insert an already-approved WP comment as published. Idempotent:
 * a duplicate wp_comment_id is ignored (returns null). */
export function insertImportedComment(db: Db, c: ImportedComment): number | null {
  const existing = db
    .prepare<{ id: number }>('SELECT id FROM comments WHERE wp_comment_id = ?')
    .get(c.wpCommentId);
  if (existing) return null;
  const r = db
    .prepare(
      `INSERT INTO comments
         (post_id, parent_id, wp_comment_id, author_name, author_email,
          author_url, body, status, source, created_at)
       VALUES (?, ?, ?, ?, 'imported@roll-along', ?, ?, 'published',
               'wp-import', ?)`
    )
    .run(
      c.postId,
      c.parentId,
      c.wpCommentId,
      c.authorName,
      c.authorUrl,
      c.body,
      c.createdAt
    );
  return r.lastInsertRowid;
}

export function getCommentById(db: Db, id: number): CommentRow | undefined {
  return db.prepare<CommentRow>('SELECT * FROM comments WHERE id = ?').get(id);
}

export function setCommentStatus(db: Db, id: number, status: CommentStatus): void {
  db.prepare('UPDATE comments SET status = ? WHERE id = ?').run(status, id);
}

/** Persist a classifier verdict and resolve the row's status. */
export function applyClassification(
  db: Db,
  id: number,
  v: { status: 'published' | 'queued'; score: number | null; reason: string | null }
): void {
  db.prepare(
    `UPDATE comments
       SET status = ?, spam_score = ?, spam_reason = ?, classified_at = ?
     WHERE id = ?`
  ).run(v.status, v.score, v.reason, new Date().toISOString(), id);
}

export interface ThreadComment {
  id: number;
  author_name: string;
  author_url: string | null;
  body: string;
  created_at: string;
  replies: ThreadComment[];
}

/** Published comments for a post: top-level oldest-first, each with its
 * published replies oldest-first. */
export function listPublishedThread(db: Db, postId: number): ThreadComment[] {
  const rows = db
    .prepare<{
      id: number;
      parent_id: number | null;
      author_name: string;
      author_url: string | null;
      body: string;
      created_at: string;
    }>(
      `SELECT id, parent_id, author_name, author_url, body, created_at
         FROM comments
        WHERE post_id = ? AND status = 'published'
        ORDER BY created_at ASC, id ASC`
    )
    .all(postId);

  const top: ThreadComment[] = [];
  const byId = new Map<number, ThreadComment>();
  for (const r of rows) {
    if (r.parent_id === null) {
      const node: ThreadComment = {
        id: r.id,
        author_name: r.author_name,
        author_url: r.author_url,
        body: r.body,
        created_at: r.created_at,
        replies: []
      };
      byId.set(r.id, node);
      top.push(node);
    }
  }
  for (const r of rows) {
    if (r.parent_id !== null) {
      const parent = byId.get(r.parent_id);
      if (parent) {
        parent.replies.push({
          id: r.id,
          author_name: r.author_name,
          author_url: r.author_url,
          body: r.body,
          created_at: r.created_at,
          replies: []
        });
      }
    }
  }
  return top;
}

export interface ModerationRow {
  id: number;
  post_slug: string;
  author_name: string;
  body: string;
  status: CommentStatus;
  spam_score: number | null;
  spam_reason: string | null;
  created_at: string;
}

/** Moderation list: queued first (oldest-first so the backlog drains
 * FIFO), then the most recent published, capped. */
export function listForModeration(db: Db, limit = 100): ModerationRow[] {
  return db
    .prepare<ModerationRow>(
      `SELECT c.id, p.slug AS post_slug, c.author_name, c.body, c.status,
              c.spam_score, c.spam_reason, c.created_at
         FROM comments c
         JOIN posts p ON p.id = c.post_id
        WHERE c.status IN ('queued','published')
        ORDER BY (c.status = 'queued') DESC,
                 CASE WHEN c.status = 'queued' THEN c.created_at END ASC,
                 c.created_at DESC
        LIMIT ?`
    )
    .all(limit);
}

/** SELECT id FROM posts WHERE slug — comments need the numeric post id
 * which the reindex IndexedPost shape doesn't expose. */
export function getPostIdBySlug(db: Db, slug: string): number | null {
  return (
    db.prepare<{ id: number }>('SELECT id FROM posts WHERE slug = ?').get(slug)?.id ?? null
  );
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/lib/comments.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/migrations/004_comments.sql src/lib/comments.ts test/lib/comments.test.ts
git commit -m "feat(comments): add comments table + persistence library"
```

---

## Task 2: Spam classifier (HTTP → Ollama proxy)

**Files:**
- Create: `src/lib/spam-classifier.ts`
- Test: `test/lib/spam-classifier.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/lib/spam-classifier.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyComment, type SpamFetcher } from '../../src/lib/spam-classifier.ts';

const cfg = {
  baseUrl: 'https://symon.example/ollama',
  token: 'tok',
  model: 'llama3.2:3b',
  timeoutMs: 1000,
  maxAttempts: 3
};

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify({ response: JSON.stringify(obj) }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

test('ham verdict is parsed and returned', async () => {
  const fetcher: SpamFetcher = async () =>
    jsonResponse({ verdict: 'ham', score: 0.02, reason: 'normal' });
  const v = await classifyComment(
    { authorName: 'A', authorEmail: 'a@e.com', authorUrl: null, body: 'nice post' },
    { ...cfg, fetcher }
  );
  assert.equal(v.verdict, 'ham');
  assert.equal(v.score, 0.02);
});

test('spam verdict is parsed and returned', async () => {
  const fetcher: SpamFetcher = async () =>
    jsonResponse({ verdict: 'spam', score: 0.97, reason: 'links' });
  const v = await classifyComment(
    { authorName: 'X', authorEmail: 'x@e.com', authorUrl: 'http://x', body: 'buy now http://a http://b' },
    { ...cfg, fetcher }
  );
  assert.equal(v.verdict, 'spam');
});

test('sends bearer token and model to /api/generate', async () => {
  let seenUrl = '';
  let seenAuth: string | null = null;
  let seenModel: unknown;
  const fetcher: SpamFetcher = async (url, init) => {
    seenUrl = url;
    seenAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
    seenModel = JSON.parse(String(init?.body)).model;
    return jsonResponse({ verdict: 'ham', score: 0, reason: 'ok' });
  };
  await classifyComment(
    { authorName: 'A', authorEmail: 'a@e.com', authorUrl: null, body: 'hi' },
    { ...cfg, fetcher }
  );
  assert.equal(seenUrl, 'https://symon.example/ollama/api/generate');
  assert.equal(seenAuth, 'Bearer tok');
  assert.equal(seenModel, 'llama3.2:3b');
});

test('retries on failure up to maxAttempts then throws', async () => {
  let calls = 0;
  const fetcher: SpamFetcher = async () => {
    calls++;
    throw new Error('connection refused');
  };
  await assert.rejects(
    () =>
      classifyComment(
        { authorName: 'A', authorEmail: 'a@e.com', authorUrl: null, body: 'hi' },
        { ...cfg, fetcher }
      ),
    /spam classify failed after 3 attempts/
  );
  assert.equal(calls, 3);
});

test('unparseable model output throws', async () => {
  const fetcher: SpamFetcher = async () =>
    new Response(JSON.stringify({ response: 'not json at all' }), { status: 200 });
  await assert.rejects(
    () =>
      classifyComment(
        { authorName: 'A', authorEmail: 'a@e.com', authorUrl: null, body: 'hi' },
        { ...cfg, fetcher, maxAttempts: 1 }
      ),
    /spam classify failed after 1 attempts/
  );
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/lib/spam-classifier.test.ts`
Expected: FAIL — cannot find module `../../src/lib/spam-classifier.ts`.

- [ ] **Step 3: Implement `src/lib/spam-classifier.ts`**

```ts
// Spam classifier. Calls the token-auth'd Ollama proxy on symon
// (/ollama/api/generate) with a pinned prompt and format=json. Pure
// HTTP — no DB, no env reads (caller passes config so it's testable and
// the job handler controls retry/fallback policy). Bounded retries live
// here because the jobs table has no auto-retry; on exhaustion we throw
// and the handler fails the comment safe (→ 'queued').

export interface SpamInput {
  authorName: string;
  authorEmail: string;
  authorUrl: string | null;
  body: string;
}

export interface SpamVerdict {
  verdict: 'ham' | 'spam';
  score: number; // 0..1
  reason: string;
}

export type SpamFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ClassifyConfig {
  baseUrl: string; // e.g. https://symon.rkroll.com/ollama (no trailing slash needed)
  token: string;
  model: string;
  timeoutMs: number;
  maxAttempts: number;
  fetcher?: SpamFetcher;
}

const SYSTEM_PROMPT = [
  'You are a spam classifier for blog comments on a personal photography blog.',
  'Classify the comment as "spam" or "ham" (not spam).',
  'Treat as spam: unsolicited promotion, SEO link-dropping, link-heavy or',
  'gibberish text, off-topic advertising, or content unrelated to a photo blog.',
  'Treat as ham: short appreciative notes, questions, on-topic discussion —',
  'brevity is normal and is NOT spam.',
  'Respond with ONLY a JSON object, no prose, exactly:',
  '{"verdict":"ham|spam","score":<0..1 spam probability>,"reason":"<short>"}'
].join(' ');

function buildPrompt(c: SpamInput): string {
  return [
    SYSTEM_PROMPT,
    '',
    `Author name: ${c.authorName}`,
    `Author email: ${c.authorEmail}`,
    `Author website: ${c.authorUrl ?? '(none)'}`,
    'Comment body:',
    c.body
  ].join('\n');
}

function parseVerdict(modelText: string): SpamVerdict {
  // The model may wrap JSON in stray text; grab the first {...} block.
  const m = modelText.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON object in model output');
  const parsed = JSON.parse(m[0]) as Record<string, unknown>;
  const verdict = parsed.verdict === 'spam' ? 'spam' : parsed.verdict === 'ham' ? 'ham' : null;
  if (verdict === null) throw new Error('missing verdict field');
  const scoreRaw = typeof parsed.score === 'number' ? parsed.score : verdict === 'spam' ? 1 : 0;
  const score = Math.max(0, Math.min(1, scoreRaw));
  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 280) : '';
  return { verdict, score, reason };
}

async function callOnce(input: SpamInput, cfg: ClassifyConfig): Promise<SpamVerdict> {
  const fetcher = cfg.fetcher ?? (globalThis.fetch as SpamFetcher);
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/api/generate`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: cfg.model,
        prompt: buildPrompt(input),
        stream: false,
        format: 'json',
        options: { temperature: 0 }
      }),
      signal: ac.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { response?: unknown };
    if (typeof data.response !== 'string') throw new Error('no response field');
    return parseVerdict(data.response);
  } finally {
    clearTimeout(timer);
  }
}

export async function classifyComment(
  input: SpamInput,
  cfg: ClassifyConfig
): Promise<SpamVerdict> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return await callOnce(input, cfg);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `spam classify failed after ${cfg.maxAttempts} attempts: ${
      (lastErr as Error)?.message ?? String(lastErr)
    }`
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/lib/spam-classifier.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/spam-classifier.ts test/lib/spam-classifier.test.ts
git commit -m "feat(comments): add Ollama-backed spam classifier with bounded retries"
```

---

## Task 3: Classify job handler + jobs wiring

**Files:**
- Create: `src/lib/classify-handler.ts`
- Modify: `src/lib/jobs.ts` (JobKind, ClassifyPayload, DEFAULT_HANDLERS)
- Modify: `src/server.ts:211-215` (worker ctx) and `src/server.ts` (urlencoded parser — done in Task 5; here only ctx)
- Modify: `src/cli/render.ts` (drain-worker ctx gets db)
- Test: `test/lib/classify-handler.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/lib/classify-handler.test.ts`:

```ts
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';

import { applyClassification, getCommentById, insertWebComment } from '../../src/lib/comments.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { makeClassifyHandler } from '../../src/lib/classify-handler.ts';
import type { SpamVerdict } from '../../src/lib/spam-classifier.ts';

function setup(t: TestContext) {
  const db = open(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO posts (slug,title,status,created_at,updated_at,published_at,path)
     VALUES ('p','P','published','2026-01-01','2026-01-01','2026-01-01','content/posts/p.md')`
  ).run();
  const postId = db.prepare<{ id: number }>('SELECT id FROM posts').get()?.id as number;
  t.after(() => db.close());
  const id = insertWebComment(db, {
    postId, parentId: null, authorName: 'A', authorEmail: 'a@e.com',
    authorUrl: null, body: 'hello', ip: null
  });
  return { db, id };
}

test('ham verdict publishes the comment', async (t) => {
  const { db, id } = setup(t);
  const handler = makeClassifyHandler(async (): Promise<SpamVerdict> => ({
    verdict: 'ham', score: 0.01, reason: 'ok'
  }));
  await handler({ commentId: id }, { siteRoot: '/x', db });
  assert.equal(getCommentById(db, id)?.status, 'published');
  assert.equal(getCommentById(db, id)?.spam_score, 0.01);
});

test('spam verdict queues the comment', async (t) => {
  const { db, id } = setup(t);
  const handler = makeClassifyHandler(async (): Promise<SpamVerdict> => ({
    verdict: 'spam', score: 0.95, reason: 'links'
  }));
  await handler({ commentId: id }, { siteRoot: '/x', db });
  assert.equal(getCommentById(db, id)?.status, 'queued');
});

test('classifier throwing → comment fails safe to queued (job does NOT throw)', async (t) => {
  const { db, id } = setup(t);
  const handler = makeClassifyHandler(async () => {
    throw new Error('ollama unreachable');
  });
  await handler({ commentId: id }, { siteRoot: '/x', db });
  assert.equal(getCommentById(db, id)?.status, 'queued');
});

test('a comment no longer pending is left untouched', async (t) => {
  const { db, id } = setup(t);
  applyClassification(db, id, { status: 'published', score: 0, reason: 'manual' });
  const handler = makeClassifyHandler(async (): Promise<SpamVerdict> => ({
    verdict: 'spam', score: 1, reason: 'x'
  }));
  await handler({ commentId: id }, { siteRoot: '/x', db });
  assert.equal(getCommentById(db, id)?.status, 'published');
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/lib/classify-handler.test.ts`
Expected: FAIL — cannot find module `../../src/lib/classify-handler.ts`.

- [ ] **Step 3: Implement `src/lib/classify-handler.ts`**

```ts
// The `classify` job handler. Glue between comments.ts (DB) and
// spam-classifier.ts (HTTP). Fail-safe: any classifier error resolves
// the comment to 'queued' (human review) and the job completes
// normally — an unscored comment must never auto-publish, and a
// thrown job would just sit 'failed' with no retry (jobs.ts has no
// auto-retry; the classifier already retried internally).

import { applyClassification, getCommentById } from './comments.ts';
import type { Db } from './db.ts';
import type { JobHandler } from './jobs.ts';
import { classifyComment, type ClassifyConfig, type SpamVerdict } from './spam-classifier.ts';

export interface ClassifyPayload {
  commentId: number;
}

export type Classifier = (input: {
  authorName: string;
  authorEmail: string;
  authorUrl: string | null;
  body: string;
}) => Promise<SpamVerdict>;

/** Build the env-backed production classifier. Reads config lazily so
 * importing this module has no side effects and tests can bypass it. */
export function envClassifier(): Classifier {
  const cfg: Omit<ClassifyConfig, 'fetcher'> = {
    baseUrl: process.env.OLLAMA_BASE_URL ?? '',
    token: process.env.OLLAMA_TOKEN ?? '',
    model: process.env.SPAM_MODEL ?? 'llama3.2:3b',
    timeoutMs: Number(process.env.SPAM_TIMEOUT_MS ?? 8000),
    maxAttempts: Number(process.env.SPAM_MAX_ATTEMPTS ?? 3)
  };
  return (input) => classifyComment(input, cfg);
}

/** Create a classify JobHandler around a Classifier. The handler reads
 * `ctx.db` (server.ts + cli/render.ts both put the Db in ctx). */
export function makeClassifyHandler(classifier: Classifier): JobHandler<ClassifyPayload> {
  return async (payload, ctx) => {
    const db = ctx.db as Db | undefined;
    if (!db) throw new Error('classify handler requires ctx.db');
    const comment = getCommentById(db, payload.commentId);
    if (!comment || comment.status !== 'pending') return;
    try {
      const v = await classifier({
        authorName: comment.author_name,
        authorEmail: comment.author_email,
        authorUrl: comment.author_url,
        body: comment.body
      });
      applyClassification(db, payload.commentId, {
        status: v.verdict === 'ham' ? 'published' : 'queued',
        score: v.score,
        reason: v.reason
      });
    } catch (err) {
      applyClassification(db, payload.commentId, {
        status: 'queued',
        score: null,
        reason: `classify failed: ${(err as Error).message}`.slice(0, 280)
      });
    }
  };
}
```

- [ ] **Step 4: Wire into `src/lib/jobs.ts`**

In `src/lib/jobs.ts`, change the `JobKind` type (line 45):

```ts
type JobKind = 'render' | 'classify';
```

Add an import near the top imports (after the `renderDerivative` import, line 16):

```ts
import { type ClassifyPayload, envClassifier, makeClassifyHandler } from './classify-handler.ts';
```

Re-export the payload type so callers import it from `jobs.ts` (add after `export interface RenderPayload` near line 47):

```ts
export type { ClassifyPayload } from './classify-handler.ts';
```

Replace the `DEFAULT_HANDLERS` definition (line 174):

```ts
const DEFAULT_HANDLERS: JobHandlerMap = {
  render: renderHandler as JobHandler<unknown>,
  classify: makeClassifyHandler(envClassifier()) as JobHandler<unknown>
};
```

(`makeClassifyHandler(envClassifier())` builds the production classifier lazily — `envClassifier()` only reads `process.env` when invoked, which is at module load; that's a pure config read, no I/O, so it satisfies the no-top-level-side-effects rule the same way `os.cpus()` defaults do.)

- [ ] **Step 5: Pass `db` into the worker ctx**

In `src/server.ts`, the worker block at lines 211-215 currently is:

```ts
      const ctrl = workQueue({
        db: opts.db,
        ctx: { siteRoot },
        concurrency: 1
      });
```

Change `ctx` to include the db:

```ts
      const ctrl = workQueue({
        db: opts.db,
        ctx: { siteRoot, db: opts.db },
        concurrency: 1
      });
```

In `src/cli/render.ts`, find the `workQueue({ ... ctx: { siteRoot ... } ... })` call (it drains and exits). Add `db` to its `ctx` object so a manual `site-admin render` that happens to claim a queued `classify` job processes it instead of failing it. Concretely, locate the `ctx:` property in that call and change `ctx: { siteRoot }` (or equivalent) to `ctx: { siteRoot, db }`, where `db` is the already-opened database handle in that file (the same handle passed as `workQueue({ db, ... })`).

- [ ] **Step 6: Run the handler test + the jobs tests, verify they pass**

```
node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/lib/classify-handler.test.ts
node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/lib/jobs.test.ts test/lib/jobs-handlers.test.ts
```
Expected: classify-handler PASS (4 tests); jobs + jobs-handlers PASS (no regressions).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If `cli/render.ts` complains the `db` symbol name differs, use the actual local variable name for the opened DB in that file.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/classify-handler.ts src/lib/jobs.ts src/server.ts src/cli/render.ts test/lib/classify-handler.test.ts
git commit -m "feat(comments): classify job handler + jobs/worker wiring"
```

---

## Task 4: Comment list + form templates

**Files:**
- Create: `src/templates/comments.ts`
- Test: `test/templates/comments.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/templates/comments.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ThreadComment } from '../../src/lib/comments.ts';
import { renderCommentForm, renderCommentList } from '../../src/templates/comments.ts';

test('renderCommentList escapes author and body and nests one reply level', () => {
  const thread: ThreadComment[] = [
    {
      id: 1,
      author_name: '<script>x</script>',
      author_url: null,
      body: 'hello & <b>world</b>',
      created_at: '2026-05-01T00:00:00.000Z',
      replies: [
        {
          id: 2,
          author_name: 'Bob',
          author_url: 'http://bob.example',
          body: 'reply',
          created_at: '2026-05-02T00:00:00.000Z',
          replies: []
        }
      ]
    }
  ];
  const html = renderCommentList(thread);
  assert.ok(!html.includes('<script>x</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('hello &amp; &lt;b&gt;world&lt;/b&gt;'));
  // External author link is rel-protected.
  assert.match(html, /rel="nofollow ugc noopener"/);
  // One reply, rendered as a nested list item.
  assert.match(html, /class="rkr-comment-replies"/);
});

test('renderCommentList shows an empty-state when there are no comments', () => {
  assert.match(renderCommentList([]), /No comments yet/);
});

test('renderCommentForm includes honeypot + timestamp + reply target', () => {
  const html = renderCommentForm('my-post', { replyTo: 42 });
  assert.match(html, /action="\/my-post\/comments"/);
  assert.match(html, /name="website"/); // honeypot
  assert.match(html, /name="t"/); // render timestamp
  assert.match(html, /name="parent_id" value="42"/);
  assert.match(html, /name="name"/);
  assert.match(html, /name="email"/);
  assert.match(html, /name="body"/);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/templates/comments.test.ts`
Expected: FAIL — cannot find module `../../src/templates/comments.ts`.

- [ ] **Step 3: Implement `src/templates/comments.ts`**

```ts
// Comment list + submission form. Template-literal HTML (spec.md §8).
// All user-controlled text goes through escapeText/escapeAttr. The
// form works without JS (native POST → 303 redirect); site JS may
// enhance it later but is not required.

import type { ThreadComment } from '../lib/comments.ts';
import { escapeAttr, escapeText } from '../lib/content.ts';

function authorHtml(name: string, url: string | null): string {
  const safeName = escapeText(name);
  if (!url) return safeName;
  // Only http/https author URLs become links; anything else renders as text.
  if (!/^https?:\/\//i.test(url)) return safeName;
  return `<a href="${escapeAttr(url)}" rel="nofollow ugc noopener" target="_blank">${safeName}</a>`;
}

function commentItem(c: ThreadComment, withReplies: boolean): string {
  const replies =
    withReplies && c.replies.length > 0
      ? `<ol class="rkr-comment-replies">${c.replies
          .map((r) => commentItem(r, false))
          .join('')}</ol>`
      : '';
  return `<li class="rkr-comment" id="comment-${c.id}">
<div class="rkr-comment-meta">${authorHtml(c.author_name, c.author_url)} · <time datetime="${escapeAttr(
    c.created_at
  )}">${escapeText(c.created_at.slice(0, 10))}</time></div>
<div class="rkr-comment-body">${escapeText(c.body)}</div>
${replies}</li>`;
}

export function renderCommentList(thread: ThreadComment[]): string {
  if (thread.length === 0) {
    return `<section class="rkr-comments" id="comments"><h2>Comments</h2><p class="rkr-comments-empty">No comments yet — be the first.</p></section>`;
  }
  const items = thread.map((c) => commentItem(c, true)).join('');
  return `<section class="rkr-comments" id="comments"><h2>Comments</h2><ol class="rkr-comment-list">${items}</ol></section>`;
}

export interface CommentFormOpts {
  /** Pre-fill parent_id for a reply. */
  replyTo?: number;
  /** Notice to show above the form (e.g. after a submit redirect). */
  notice?: string;
}

export function renderCommentForm(slug: string, opts: CommentFormOpts = {}): string {
  const notice = opts.notice
    ? `<p class="rkr-comment-notice" role="status">${escapeText(opts.notice)}</p>`
    : '';
  const parent =
    opts.replyTo !== undefined
      ? `<input type="hidden" name="parent_id" value="${escapeAttr(String(opts.replyTo))}"/>`
      : '';
  // Honeypot: real browsers leave `website` empty (hidden via CSS in the
  // theme; the field is also aria-hidden + autocomplete=off). `t` is the
  // render time in ms — submissions faster than the server threshold are
  // treated as bots. Both are defence-in-depth before the LLM check.
  return `<section class="rkr-comment-form-wrap" id="respond">
<h2>Leave a comment</h2>
${notice}
<form class="rkr-comment-form" method="POST" action="/${escapeAttr(slug)}/comments">
${parent}
<input type="hidden" name="t" value="${Date.now()}"/>
<div class="rkr-hp" aria-hidden="true">
  <label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"/></label>
</div>
<label>Name<input type="text" name="name" required maxlength="80"/></label>
<label>Email (never shown)<input type="email" name="email" required maxlength="200"/></label>
<label>Website (optional)<input type="url" name="url" maxlength="200"/></label>
<label>Comment<textarea name="body" required rows="5" maxlength="5000"></textarea></label>
<button type="submit">Post comment</button>
</form>
</section>`;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/templates/comments.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/templates/comments.ts test/templates/comments.test.ts
git commit -m "feat(comments): comment list + form templates"
```

---

## Task 5: Public submit route + urlencoded parsing

**Files:**
- Create: `src/routes/public-comments.ts`
- Modify: `src/server.ts` (register `application/x-www-form-urlencoded` parser)
- Modify: `src/routes/public.ts` (call `registerPublicCommentRoutes`)
- Test: `test/routes/public-comments.test.ts`

- [ ] **Step 1: Add the urlencoded body parser in `src/server.ts`**

After the multipart registration (`src/server.ts:111-116`, the `await app.register(multipart, …)` block), add:

```ts
  // Native HTML comment form posts application/x-www-form-urlencoded.
  // Parse it with node:querystring rather than adding a dependency.
  // JSON bodies (the rest of the API) keep Fastify's built-in parser.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );
```

- [ ] **Step 2: Write the failing test**

Create `test/routes/public-comments.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { listForModeration } from '../../src/lib/comments.ts';
import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { buildApp } from '../../src/server.ts';

async function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-cmt-'));
  const db = open(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO posts (slug,title,status,created_at,updated_at,published_at,path)
     VALUES ('hello','Hello','published','2026-01-01','2026-01-01','2026-01-01','content/posts/hello.md')`
  ).run();
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    events.removeAllListeners('enqueued');
  });
  return { app, db };
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

test('valid submission stores a pending comment + enqueues a classify job + 303', async (t) => {
  const { app, db } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/hello/comments',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ name: 'Ann', email: 'ann@e.com', url: '', body: 'nice', website: '', t: '0' })
  });
  assert.equal(res.statusCode, 303);
  assert.match(res.headers.location as string, /\/hello#respond/);
  const c = db.prepare<{ status: string }>('SELECT status FROM comments').get();
  assert.equal(c?.status, 'pending');
  const j = db.prepare<{ kind: string; state: string }>('SELECT kind,state FROM jobs').get();
  assert.equal(j?.kind, 'classify');
});

test('honeypot filled → silent reject (no row, still 303)', async (t) => {
  const { app, db } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/hello/comments',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ name: 'Bot', email: 'b@e.com', url: '', body: 'spam', website: 'x', t: '0' })
  });
  assert.equal(res.statusCode, 303);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get()?.n, 0);
});

test('missing required fields → 400', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/hello/comments',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ name: '', email: 'a@e.com', body: '', website: '', t: '0' })
  });
  assert.equal(res.statusCode, 400);
});

test('unknown post slug → 404', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/nope/comments',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ name: 'A', email: 'a@e.com', body: 'hi', website: '', t: '0' })
  });
  assert.equal(res.statusCode, 404);
});

test('too-fast submission is accepted but queued, not published-eligible', async (t) => {
  const { app, db } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/hello/comments',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({
      name: 'Speedy', email: 's@e.com', url: '', body: 'too fast',
      website: '', t: String(Date.now())
    })
  });
  assert.equal(res.statusCode, 303);
  const mod = listForModeration(db);
  assert.equal(mod[0]?.status, 'queued');
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/routes/public-comments.test.ts`
Expected: FAIL — cannot find module `../../src/routes/public-comments.ts`.

- [ ] **Step 4: Implement `src/routes/public-comments.ts`**

```ts
// POST /:slug/comments — anonymous reader comment submission.
//
// Flow: validate → cheap anti-abuse (honeypot / min-fill-time / length)
// → insert pending row → enqueue a classify job → 303 back to the post.
// The LLM verdict (Task 3) flips pending → published | queued
// asynchronously so the reader never waits on the GPU.

import type { FastifyInstance } from 'fastify';

import { getPostIdBySlug, insertWebComment, setCommentStatus } from '../lib/comments.ts';
import type { Db } from '../lib/db.ts';
import { enqueue } from '../lib/jobs.ts';

export interface PublicCommentRoutesOpts {
  db: Db;
}

// Submissions completed faster than this after the form rendered are
// almost certainly bots. Not a hard reject (a fast human on a cached
// form is possible) — route them to moderation instead.
const MIN_FILL_MS = 3000;
const MAX = { name: 80, email: 200, url: 200, body: 5000 };

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function registerPublicCommentRoutes(
  fastify: FastifyInstance,
  opts: PublicCommentRoutesOpts
): void {
  const { db } = opts;

  fastify.post<{
    Params: { slug: string };
    Body: Record<string, unknown>;
  }>(
    '/:slug/comments',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const { slug } = req.params;
      const body = req.body ?? {};

      // Honeypot: a populated `website` field means a bot. Silent
      // success (303) so the bot can't tell it was filtered.
      if (str(body.website) !== '') {
        return reply.code(303).header('location', `/${slug}#respond`).send();
      }

      const postId = getPostIdBySlug(db, slug);
      if (postId === null) {
        return reply.code(404).send({ error: 'post not found' });
      }

      const name = str(body.name);
      const email = str(body.email);
      const url = str(body.url);
      const text = str(body.body);

      if (!name || !email || !text) {
        return reply.code(400).send({ error: 'name, email and body are required' });
      }
      if (
        name.length > MAX.name ||
        email.length > MAX.email ||
        url.length > MAX.url ||
        text.length > MAX.body
      ) {
        return reply.code(400).send({ error: 'a field exceeds its maximum length' });
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return reply.code(400).send({ error: 'invalid email' });
      }

      // Optional reply target. Must parse to a positive int; the
      // top-level-parent rule is enforced in insertWebComment.
      let parentId: number | null = null;
      const rawParent = str(body.parent_id);
      if (rawParent !== '') {
        const n = Number.parseInt(rawParent, 10);
        if (!Number.isInteger(n) || n <= 0) {
          return reply.code(400).send({ error: 'invalid parent_id' });
        }
        parentId = n;
      }

      let id: number;
      try {
        id = insertWebComment(db, {
          postId,
          parentId,
          authorName: name,
          authorEmail: email,
          authorUrl: url || null,
          body: text,
          ip: req.ip ?? null
        });
      } catch (err) {
        // Bad parent (not found / not top-level) — treat as client error.
        return reply.code(400).send({ error: (err as Error).message });
      }

      // Too-fast fill → straight to moderation, skip the classify job
      // (we already distrust it; don't spend GPU on it).
      const tRaw = Number.parseInt(str(body.t), 10);
      const tooFast = Number.isFinite(tRaw) && tRaw > 0 && Date.now() - tRaw < MIN_FILL_MS;
      if (tooFast) {
        setCommentStatus(db, id, 'queued');
      } else {
        enqueue(db, { kind: 'classify', payload: { commentId: id } });
      }

      return reply.code(303).header('location', `/${slug}#respond`).send();
    }
  );
}
```

- [ ] **Step 5: Register from `src/routes/public.ts`**

Add the import alongside the other route/template imports (near line 67-70):

```ts
import { registerPublicCommentRoutes } from './public-comments.ts';
```

Inside `publicRoutes`, right after `widgets.register(figureWidget);` (line 150), add:

```ts
  registerPublicCommentRoutes(fastify, { db });
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/routes/public-comments.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add src/routes/public-comments.ts src/routes/public.ts src/server.ts test/routes/public-comments.test.ts
git commit -m "feat(comments): public submit route + urlencoded parsing + anti-abuse"
```

---

## Task 6: Render comments on the post page

**Files:**
- Modify: `src/templates/post.ts` (accept + render comments + form)
- Modify: `src/routes/public.ts` (load thread, pass to template)
- Test: `test/routes/public-comment-render.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/routes/public-comment-render.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { insertWebComment, setCommentStatus } from '../../src/lib/comments.ts';
import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { buildApp } from '../../src/server.ts';

async function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-cmtr-'));
  fs.mkdirSync(path.join(root, 'content', 'posts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'content', 'posts', 'hello.md'),
    '---\ntitle: Hello\nslug: hello\ndate: 2026-01-01T00:00:00.000Z\nstatus: published\n---\n\nBody.\n'
  );
  const db = open(':memory:');
  migrate(db);
  // Reindex so GET /:slug finds the post.
  const { runReindex } = await import('../../src/cli/reindex.ts');
  runReindex(root);
  const postId = db.prepare<{ id: number }>("SELECT id FROM posts WHERE slug='hello'").get()
    ?.id as number;
  void postId;
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    events.removeAllListeners('enqueued');
  });
  return { app, db };
}

test('published comments render on the post page; pending do not', async (t) => {
  const { app, db } = await setup(t);
  const pid = db.prepare<{ id: number }>("SELECT id FROM posts WHERE slug='hello'").get()
    ?.id as number;
  const a = insertWebComment(db, {
    postId: pid, parentId: null, authorName: 'Ann', authorEmail: 'a@e.com',
    authorUrl: null, body: 'visible comment', ip: null
  });
  setCommentStatus(db, a, 'published');
  insertWebComment(db, {
    postId: pid, parentId: null, authorName: 'Hidden', authorEmail: 'h@e.com',
    authorUrl: null, body: 'pending comment', ip: null
  });
  const res = await app.inject({ method: 'GET', url: '/hello' });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('visible comment'));
  assert.ok(!res.body.includes('pending comment'));
  assert.match(res.body, /action="\/hello\/comments"/);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/routes/public-comment-render.test.ts`
Expected: FAIL — comments + form not present in body.

- [ ] **Step 3: Extend `src/templates/post.ts`**

Add to the imports at the top of `src/templates/post.ts` (after the existing `escape*` import on line 3):

```ts
import { renderCommentForm, renderCommentList } from './comments.ts';
import type { ThreadComment } from '../lib/comments.ts';
```

Add to the `PostPageData` interface (inside the interface, after `isAdmin?: boolean;`):

```ts
  /** Published comment thread for this post. */
  comments?: ThreadComment[];
```

In `renderPostPage`, just before the final `return` template literal, build the block:

```ts
  const commentsBlock = `${renderCommentList(post.comments ?? [])}\n${renderCommentForm(post.slug)}`;
```

Then in the returned HTML, replace the `</article>` / `</main>` region:

```ts
${post.bodyHtml}
</article>
${commentsBlock}
</main>
```

(That is: insert `${commentsBlock}` between `</article>` and `</main>`.)

- [ ] **Step 4: Load the thread in `src/routes/public.ts`**

Add to the comments-lib import surface — add this import near line 44 (`import type { Db } from '../lib/db.ts';`):

```ts
import { getPostIdBySlug, listPublishedThread } from '../lib/comments.ts';
```

In the `GET /:slug` handler, after `const bodyHtml = await renderPostHtml(parsed.ast, ctx);` (line 282) and before `const html = renderPostPage({`, add:

```ts
    const postId = getPostIdBySlug(db, parsed.frontmatter.slug);
    const comments = postId === null ? [] : listPublishedThread(db, postId);
```

Then add `comments` to the `renderPostPage({ … })` call (alongside `isAdmin: !!req.user`):

```ts
      isAdmin: !!req.user,
      comments
```

- [ ] **Step 5: Run the test + the existing post-template test, verify pass**

```
node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/routes/public-comment-render.test.ts
node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/routes/public.test.ts test/routes/public-pages.test.ts
```
Expected: new test PASS; existing public route tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add src/templates/post.ts src/routes/public.ts test/routes/public-comment-render.test.ts
git commit -m "feat(comments): render published comments + form on post page"
```

---

## Task 7: Moderation page + actions

**Files:**
- Create: `src/templates/admin-comments.ts`
- Create: `src/routes/admin-comments.ts`
- Modify: `src/routes/admin.ts` (register the routes)
- Test: `test/routes/admin-comments.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/routes/admin-comments.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { getCommentById, insertWebComment } from '../../src/lib/comments.ts';
import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { buildApp } from '../../src/server.ts';

async function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-admc-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const dbPath = path.join(root, 'data', 'site.db');
  const db = open(dbPath);
  migrate(db);
  db.prepare(
    `INSERT INTO posts (slug,title,status,created_at,updated_at,published_at,path)
     VALUES ('p','P','published','2026-01-01','2026-01-01','2026-01-01','content/posts/p.md')`
  ).run();
  const pid = db.prepare<{ id: number }>('SELECT id FROM posts').get()?.id as number;
  const id = insertWebComment(db, {
    postId: pid, parentId: null, authorName: 'Sue', authorEmail: 's@e.com',
    authorUrl: null, body: 'queued one', ip: null
  });
  db.prepare("UPDATE comments SET status='queued' WHERE id=?").run(id);
  // No auth wiring → requireAuth is false → routes are open (matches the
  // pattern other admin-route tests use).
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    events.removeAllListeners('enqueued');
  });
  return { app, db, id };
}

test('GET /admin/comments lists queued comments', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/admin/comments' });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('queued one'));
});

test('POST /admin/comments/:id/approve → published + 303', async (t) => {
  const { app, db, id } = await setup(t);
  const res = await app.inject({ method: 'POST', url: `/admin/comments/${id}/approve` });
  assert.equal(res.statusCode, 303);
  assert.equal(getCommentById(db, id)?.status, 'published');
});

test('POST /admin/comments/:id/reject → rejected', async (t) => {
  const { app, db, id } = await setup(t);
  await app.inject({ method: 'POST', url: `/admin/comments/${id}/reject` });
  assert.equal(getCommentById(db, id)?.status, 'rejected');
});

test('POST /admin/comments/:id/delete → row gone', async (t) => {
  const { app, db, id } = await setup(t);
  await app.inject({ method: 'POST', url: `/admin/comments/${id}/delete` });
  assert.equal(getCommentById(db, id), undefined);
});

test('unknown action → 400', async (t) => {
  const { app, id } = await setup(t);
  const res = await app.inject({ method: 'POST', url: `/admin/comments/${id}/bogus` });
  assert.equal(res.statusCode, 400);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/routes/admin-comments.test.ts`
Expected: FAIL — 404s (routes not registered).

- [ ] **Step 3: Implement `src/templates/admin-comments.ts`**

```ts
// Server-rendered moderation page. No SPA bundle — plain form POSTs so
// it works with the existing admin auth (cookie or bearer) and the
// strict CSP. Queued first (the backlog), then recent published.

import type { ModerationRow } from '../lib/comments.ts';
import { escapeAttr, escapeText } from '../lib/content.ts';

function row(c: ModerationRow): string {
  const score =
    c.spam_score === null ? '' : ` · spam ${(c.spam_score * 100).toFixed(0)}%`;
  const reason = c.spam_reason ? ` · ${escapeText(c.spam_reason)}` : '';
  const actions =
    c.status === 'queued'
      ? `<form method="POST" action="/admin/comments/${c.id}/approve"><button>Approve</button></form>
<form method="POST" action="/admin/comments/${c.id}/reject"><button>Reject</button></form>`
      : `<form method="POST" action="/admin/comments/${c.id}/delete"><button>Delete</button></form>`;
  return `<li class="amc-row amc-${escapeAttr(c.status)}">
<div class="amc-meta">#${c.id} · ${escapeText(c.author_name)} · /${escapeText(
    c.post_slug
  )} · ${escapeText(c.created_at.slice(0, 10))} · <strong>${escapeText(
    c.status
  )}</strong>${escapeText(score)}${reason}</div>
<div class="amc-body">${escapeText(c.body)}</div>
<div class="amc-actions">${actions}</div>
</li>`;
}

export function renderAdminCommentsPage(rows: ModerationRow[]): string {
  const list =
    rows.length === 0
      ? '<p>No comments.</p>'
      : `<ol class="amc-list">${rows.map(row).join('')}</ol>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Comment moderation</title>
<style>
body{font:16px/1.5 system-ui;margin:2rem;max-width:60rem}
.amc-list{list-style:none;padding:0}
.amc-row{border:1px solid #ccc;border-radius:6px;padding:1rem;margin:.75rem 0}
.amc-queued{border-color:#c60}
.amc-meta{font-size:.85rem;color:#555}
.amc-body{white-space:pre-wrap;margin:.5rem 0}
.amc-actions{display:flex;gap:.5rem}
.amc-actions form{margin:0}
</style></head><body>
<h1>Comment moderation</h1>
${list}
</body></html>`;
}
```

- [ ] **Step 4: Implement `src/routes/admin-comments.ts`**

```ts
// /admin/comments — moderation list + approve/reject/delete actions.
// Mirrors the registerAdminTagsRoute pattern: opens the on-disk DB from
// siteRoot, applies the shared `guard` (requireUser when auth is wired).

import path from 'node:path';

import type { FastifyInstance, RouteShorthandOptions } from 'fastify';

import { open } from '../lib/db.ts';
import { getCommentById, listForModeration, setCommentStatus } from '../lib/comments.ts';
import { renderAdminCommentsPage } from '../templates/admin-comments.ts';

export interface AdminCommentsRouteOpts {
  siteRoot: string;
  guard: RouteShorthandOptions;
}

const ACTIONS = new Set(['approve', 'reject', 'delete']);

export function registerAdminCommentsRoutes(
  fastify: FastifyInstance,
  opts: AdminCommentsRouteOpts
): void {
  const { siteRoot, guard } = opts;
  const dbPath = path.join(siteRoot, 'data', 'site.db');

  fastify.get('/admin/comments', { ...guard }, async (_req, reply) => {
    const db = open(dbPath);
    try {
      return reply
        .type('text/html; charset=utf-8')
        .header('Cache-Control', 'private, no-store')
        .send(renderAdminCommentsPage(listForModeration(db)));
    } finally {
      db.close();
    }
  });

  fastify.post<{ Params: { id: string; action: string } }>(
    '/admin/comments/:id/:action',
    { ...guard },
    async (req, reply) => {
      const { action } = req.params;
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0 || !ACTIONS.has(action)) {
        return reply.code(400).send({ error: 'bad request' });
      }
      const db = open(dbPath);
      try {
        const c = getCommentById(db, id);
        if (!c) return reply.code(404).send({ error: 'comment not found' });
        if (action === 'approve') setCommentStatus(db, id, 'published');
        else if (action === 'reject') setCommentStatus(db, id, 'rejected');
        else db.prepare('DELETE FROM comments WHERE id = ?').run(id);
        return reply.code(303).header('location', '/admin/comments').send();
      } finally {
        db.close();
      }
    }
  );
}
```

- [ ] **Step 5: Register in `src/routes/admin.ts`**

Add the import next to the other `register*` route imports (near line 41, after `registerAdminTagsRoute`):

```ts
import { registerAdminCommentsRoutes } from './admin-comments.ts';
```

Call it right after `registerAdminTagsRoute(fastify, { siteRoot, guard });` (line 133):

```ts
  registerAdminCommentsRoutes(fastify, { siteRoot, guard });
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/routes/admin-comments.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add src/templates/admin-comments.ts src/routes/admin-comments.ts src/routes/admin.ts test/routes/admin-comments.test.ts
git commit -m "feat(comments): server-rendered moderation page + actions"
```

---

## Task 8: WP REST `listComments` + type

**Files:**
- Modify: `src/lib/wp-import-types.ts` (add `WpComment`)
- Modify: `src/lib/wp-rest.ts` (add `listComments`)
- Test: `test/lib/wp-rest-comments.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/lib/wp-rest-comments.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listComments } from '../../src/lib/wp-rest.ts';
import type { WpFetcher } from '../../src/lib/wp-rest.ts';

test('listComments returns parsed comments + paging headers', async () => {
  const fetcher: WpFetcher = async (url) => {
    assert.match(url, /\/wp-json\/wp\/v2\/comments\?per_page=100&page=1/);
    return new Response(
      JSON.stringify([
        {
          id: 543,
          post: 2149,
          parent: 0,
          author_name: 'Linda',
          author_url: '',
          date: '2026-05-04T17:00:45',
          content: { rendered: '<p>hi</p>' }
        }
      ]),
      { status: 200, headers: { 'X-WP-Total': '37', 'X-WP-TotalPages': '1' } }
    );
  };
  const r = await listComments('https://roll-along.example/', { page: 1 }, fetcher);
  assert.equal(r.total, 37);
  assert.equal(r.totalPages, 1);
  assert.equal(r.comments[0]?.id, 543);
  assert.equal(r.comments[0]?.post, 2149);
});

test('listComments throws on non-OK', async () => {
  const fetcher: WpFetcher = async () => new Response('nope', { status: 500 });
  await assert.rejects(() => listComments('https://x.example', {}, fetcher), /WP listComments: 500/);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/lib/wp-rest-comments.test.ts`
Expected: FAIL — `listComments` is not exported.

- [ ] **Step 3: Add `WpComment` to `src/lib/wp-import-types.ts`**

Append after the `WpPost` interface (after line 21, before the `HastNode` comment):

```ts
/** Subset of WP /wp-json/wp/v2/comments we depend on for recovery. */
export interface WpComment {
  id: number;
  post: number; // WP post id
  parent: number; // 0 = top-level
  author_name: string;
  author_url: string;
  date: string; // ISO-8601, server local
  content: { rendered: string };
}
```

- [ ] **Step 4: Add `listComments` to `src/lib/wp-rest.ts`**

Add `WpComment` to the existing type import at the top (line 9):

```ts
import type { WpComment, WpPost } from './wp-import-types.ts';
```

Add a `CommentListResult` interface near `ListResult` (after line 15):

```ts
export interface CommentListResult {
  comments: WpComment[];
  total: number;
  totalPages: number;
}
```

Add the function at the end of the file (after `fetchPost`):

```ts
/** Fetch one page of approved comments (public endpoint returns only
 * approved). `_fields` trims the payload. */
export async function listComments(
  baseUrl: string,
  opts: { page?: number; perPage?: number } = {},
  fetcher: WpFetcher = defaultWpFetcher
): Promise<CommentListResult> {
  const page = opts.page ?? 1;
  const perPage = Math.min(100, Math.max(1, opts.perPage ?? 100));
  const fields = ['id', 'post', 'parent', 'author_name', 'author_url', 'date', 'content'].join(',');
  const url = `${stripTrailingSlash(baseUrl)}/wp-json/wp/v2/comments?per_page=${perPage}&page=${page}&_fields=${fields}`;
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`WP listComments: ${res.status} ${url}`);
  const total = Number(res.headers.get('X-WP-Total') ?? 0);
  const totalPages = Number(res.headers.get('X-WP-TotalPages') ?? 0);
  const comments = (await res.json()) as WpComment[];
  return { comments, total, totalPages };
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/lib/wp-rest-comments.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/wp-import-types.ts src/lib/wp-rest.ts test/lib/wp-rest-comments.test.ts
git commit -m "feat(comments): WP REST listComments + WpComment type"
```

---

## Task 9: `import-wp-comments` recovery command

**Files:**
- Create: `src/cli/import-wp-comments.ts`
- Modify: `bin/site-admin` (register the command)
- Test: `test/cli/import-wp-comments.test.ts`

**Design note:** the post-import pipeline does not persist a WP-post-id→slug map (it writes `<slug>.md` files). So the command builds the map itself by paging `/wp-json/wp/v2/posts?_fields=id,slug` via the existing `listPosts`, then maps each comment's `post` id → slug → local post id via `getPostIdBySlug`. Comments whose post isn't imported locally are skipped with a warning. Parent flattening: build `wpCommentId → localId` as we insert top-level comments; a reply whose WP parent maps to a local top-level comment is attached, otherwise it's inserted as top-level.

- [ ] **Step 1: Write the failing test**

Create `test/cli/import-wp-comments.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { importWpComments } from '../../src/cli/import-wp-comments.ts';
import type { WpFetcher } from '../../src/lib/wp-rest.ts';

function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-impc-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  db.prepare(
    `INSERT INTO posts (slug,title,status,created_at,updated_at,published_at,path)
     VALUES ('hello','Hello','published','2026-01-01','2026-01-01','2026-01-01','content/posts/hello.md')`
  ).run();
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root };
}

function wpFetcher(): WpFetcher {
  return async (url) => {
    if (url.includes('/wp/v2/posts')) {
      return new Response(JSON.stringify([{ id: 2149, slug: 'hello' }]), {
        status: 200,
        headers: { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' }
      });
    }
    // comments
    return new Response(
      JSON.stringify([
        {
          id: 10, post: 2149, parent: 0, author_name: 'Ann', author_url: '',
          date: '2026-05-01T10:00:00', content: { rendered: '<p>great&nbsp;post</p>' }
        },
        {
          id: 11, post: 2149, parent: 10, author_name: 'Bo', author_url: 'http://bo',
          date: '2026-05-02T10:00:00', content: { rendered: '<p>reply</p>' }
        },
        {
          id: 12, post: 9999, parent: 0, author_name: 'Orphan', author_url: '',
          date: '2026-05-03T10:00:00', content: { rendered: '<p>no post</p>' }
        }
      ]),
      { status: 200, headers: { 'X-WP-Total': '3', 'X-WP-TotalPages': '1' } }
    );
  };
}

test('imports approved comments, maps parent, skips unknown post, is idempotent', async (t) => {
  const { root } = setup(t);
  const r1 = await importWpComments('https://roll-along.example', root, wpFetcher());
  assert.equal(r1.inserted, 2);
  assert.equal(r1.skipped, 1);

  const db = open(path.join(root, 'data', 'site.db'));
  const rows = db
    .prepare<{ wp_comment_id: number; parent_id: number | null; body: string; status: string }>(
      'SELECT wp_comment_id,parent_id,body,status FROM comments ORDER BY wp_comment_id'
    )
    .all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.status, 'published');
  assert.ok(rows[0]?.body.includes('great')); // HTML stripped to text
  assert.ok(!rows[0]?.body.includes('<p>'));
  const top = rows.find((x) => x.wp_comment_id === 10);
  const reply = rows.find((x) => x.wp_comment_id === 11);
  assert.equal(reply?.parent_id, db.prepare<{ id: number }>(
    'SELECT id FROM comments WHERE wp_comment_id=10'
  ).get()?.id);
  void top;
  db.close();

  // Re-run: no duplicates.
  const r2 = await importWpComments('https://roll-along.example', root, wpFetcher());
  assert.equal(r2.inserted, 0);
  const db2 = open(path.join(root, 'data', 'site.db'));
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM comments').get()?.n, 2);
  db2.close();
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/cli/import-wp-comments.test.ts`
Expected: FAIL — cannot find module `../../src/cli/import-wp-comments.ts`.

- [ ] **Step 3: Implement `src/cli/import-wp-comments.ts`**

```ts
// `site-admin import-wp-comments <wp-base-url>` — one-shot, idempotent
// recovery of approved WordPress comments. The public WP comments
// endpoint returns only approved comments, so everything fetched is
// inserted as published / source='wp-import'. Idempotent via the
// comments.wp_comment_id UNIQUE column.

import path from 'node:path';

import {
  getPostIdBySlug,
  insertImportedComment
} from '../lib/comments.ts';
import { open } from '../lib/db.ts';
import { listComments, listPosts, type WpFetcher } from '../lib/wp-rest.ts';

export interface ImportCommentsResult {
  inserted: number;
  skipped: number;
}

/** Strip HTML to plain text + decode the handful of entities WP emits.
 * We store comment bodies as text (escaped on render), so tags must go. */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .trim();
}

async function buildWpIdToSlug(
  baseUrl: string,
  fetcher: WpFetcher
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  let page = 1;
  for (;;) {
    const r = await listPosts(baseUrl, { page, perPage: 100, status: 'publish' }, fetcher);
    for (const p of r.posts) map.set(p.id, p.slug);
    if (page >= r.totalPages || r.posts.length === 0) break;
    page++;
  }
  return map;
}

export async function importWpComments(
  baseUrl: string,
  siteRoot: string,
  fetcher?: WpFetcher
): Promise<ImportCommentsResult> {
  const dbPath = path.join(siteRoot, 'data', 'site.db');
  const db = open(dbPath);
  let inserted = 0;
  let skipped = 0;
  try {
    const idToSlug = await buildWpIdToSlug(baseUrl, fetcher as WpFetcher);
    // wpCommentId → local comment id, for parent mapping.
    const wpToLocal = new Map<number, number>();

    let page = 1;
    let totalPages = 1;
    do {
      const r = await listComments(baseUrl, { page, perPage: 100 }, fetcher as WpFetcher);
      totalPages = r.totalPages || 1;
      // Sort so parents are processed before replies on the same page.
      const sorted = [...r.comments].sort((a, b) => Number(a.parent) - Number(b.parent));
      for (const c of sorted) {
        const slug = idToSlug.get(c.post);
        if (!slug) {
          skipped++;
          continue;
        }
        const postId = getPostIdBySlug(db, slug);
        if (postId === null) {
          skipped++;
          continue;
        }
        let parentId: number | null = null;
        if (c.parent && wpToLocal.has(c.parent)) {
          parentId = wpToLocal.get(c.parent) as number;
        }
        const localId = insertImportedComment(db, {
          postId,
          parentId,
          wpCommentId: c.id,
          authorName: c.author_name || 'Anonymous',
          authorUrl: c.author_url ? c.author_url : null,
          body: htmlToText(c.content.rendered),
          createdAt: c.date
        });
        if (localId === null) {
          skipped++; // already imported (idempotent re-run)
        } else {
          wpToLocal.set(c.id, localId);
          inserted++;
        }
      }
      page++;
    } while (page <= totalPages);
  } finally {
    db.close();
  }
  return { inserted, skipped };
}

export default async function importWpCommentsCmd(argv: string[]): Promise<void> {
  const baseUrl = argv[0];
  if (!baseUrl) {
    throw new Error('usage: site-admin import-wp-comments <wp-base-url>');
  }
  const { paths } = await import('../lib/config.ts');
  const r = await importWpComments(baseUrl, paths().root);
  console.log(`imported ${r.inserted} comment(s), skipped ${r.skipped}`);
}
```

- [ ] **Step 4: Register in `bin/site-admin`**

In `bin/site-admin`, add to the `COMMANDS` object (after the `'import-wp'` line):

```js
  'import-wp-comments': () => import('../src/cli/import-wp-comments.ts'),
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/cli/import-wp-comments.test.ts`
Expected: PASS (1 test, both runs asserted inside).

- [ ] **Step 6: Commit**

```bash
git add src/cli/import-wp-comments.ts bin/site-admin test/cli/import-wp-comments.test.ts
git commit -m "feat(comments): idempotent import-wp-comments recovery command"
```

---

## Task 10: Config, docs, and the gpu-services proxy

**Files:**
- Modify: `secrets.env.example`
- Modify: `docs/implementation.md` (one short subsection) and `docs/DEFERRED.md` (deferred items)
- Modify (other repo): `/home/john/src/gpu-services/home/vhost.conf`

- [ ] **Step 1: Add Ollama config to `secrets.env.example`**

Append to `secrets.env.example`:

```
# Comment spam classification via the token-auth'd Ollama proxy on
# symon (see gpu-services/home/vhost.conf). If OLLAMA_BASE_URL is unset
# the classify job fails safe and every comment lands in moderation.
OLLAMA_BASE_URL=https://symon.rkroll.com/ollama
OLLAMA_TOKEN=
SPAM_MODEL=llama3.2:3b
SPAM_TIMEOUT_MS=8000
SPAM_MAX_ATTEMPTS=3
```

- [ ] **Step 2: Document the comments subsystem**

In `docs/implementation.md`, add a short subsection (match the file's existing heading style) titled "Comments" covering: the `comments` table, the async classify job (pending → published|queued), the symon Ollama proxy path, and the `import-wp-comments` recovery command. Keep it to ~15 lines, consistent with the doc's terseness.

In `docs/DEFERRED.md`, add entries (using the file's Source / What / Why deferred / Trigger format) for the out-of-scope items from the spec: email notification on new/queued comments; commenter self-service edit/delete; importing WP spam/trash/pending; multi-level threading; CAPTCHA.

- [ ] **Step 3: Add the Ollama ProxyPass to gpu-services**

Edit `/home/john/src/gpu-services/home/vhost.conf`. Inside the `<VirtualHost *:443>` block, after the existing `ProxyPass /routing/ …` / `ProxyPassReverse /routing/ …` lines and before `ErrorLog`, add:

```apache
    # Ollama (LAN-bound at 192.168.1.169:11434 via the runit service;
    # see /etc/sv/ollama/run). Behind the same token-auth Include as the
    # rest of this vhost. General-purpose; the blog calls /ollama/api/generate.
    ProxyPass /ollama/ http://192.168.1.169:11434/
    ProxyPassReverse /ollama/ http://192.168.1.169:11434/
```

- [ ] **Step 4: Verify the apache config parses (no deploy)**

This change deploys via the gpu-services `deploy.sh` flow; do not deploy here. Sanity-check the edit is well-formed (matched directive names, trailing slashes on both path and target). No automated test — this is config in a separate repo.

- [ ] **Step 5: Commit (two repos)**

```bash
# rkr-blog
git add secrets.env.example docs/implementation.md docs/DEFERRED.md
git commit -m "docs(comments): Ollama config, implementation notes, deferred items"

# gpu-services (separate repo, separate commit)
git -C /home/john/src/gpu-services add home/vhost.conf
git -C /home/john/src/gpu-services commit -m "feat: expose token-auth'd Ollama proxy at /ollama/ for rkr-blog spam triage"
```

---

## Task 11: Full gate + E2E happy path

**Files:**
- Create: `test/e2e/comments.spec.ts`

- [ ] **Step 1: Write an E2E spec mirroring the existing harness**

Read `test/e2e/public-figures.spec.ts` and `test/e2e/server-runner.ts` first to copy the exact server-runner + fixture-content pattern this repo uses (do not invent a new harness). Then create `test/e2e/comments.spec.ts` that:

1. Starts the app via the existing e2e server runner with a fixture published post.
2. Navigates to the post, fills the comment form (name/email/body, honeypot empty), submits.
3. Asserts the page shows the "comment will appear shortly"/`#respond` notice (redirect target) and the comment is NOT yet visible (status pending; worker stub).
4. Drives a deterministic outcome by enqueuing/processing a `classify` job with an injected ham classifier (or, if the e2e harness can't inject, assert the row is `pending`/`queued` via a follow-up admin page check) and verifies it then renders on reload.

Match assertions and fixture style to the existing specs; keep it to one happy-path test plus the honeypot-rejected case.

- [ ] **Step 2: Run the new E2E spec**

Run: `npm run build && npx playwright test --config test/playwright.config.ts test/e2e/comments.spec.ts`
Expected: PASS. (If Playwright's browser is missing, run `npm run setup` first.)

- [ ] **Step 3: Run the full gate**

```
npm run check
npm run knip:gate
npm run circular
```
Expected: all green. Common fixes if not:
- knip flags an unused export → ensure each new exported symbol is imported somewhere (tests count) or remove it.
- c8 per-file coverage shortfall on a new `src/**` file → add the missing-branch test (e.g. the `invalid email` / `bad parent_id` branches in `public-comments.ts`, the non-http author URL branch in `templates/comments.ts`).
- circular import between `jobs.ts` ↔ `classify-handler.ts` ↔ `comments.ts`: the dependency is one-way (`jobs.ts` → `classify-handler.ts` → {`comments.ts`,`spam-classifier.ts`}); if `dpdm` reports a cycle, it's because `classify-handler.ts` imports a `type` from `jobs.ts` — change that to `import type { JobHandler } from './jobs.ts'` (type-only imports are erased and don't form a runtime cycle; if dpdm still flags it, inline the `JobHandler` type in `classify-handler.ts`).

- [ ] **Step 4: Commit**

```bash
git add test/e2e/comments.spec.ts
git commit -m "test(comments): e2e happy path + honeypot rejection"
```

- [ ] **Step 5: Final verification before declaring done**

Confirm, with command output in hand (do not assert from memory):
- `npm run check` exits 0.
- `git -C /home/john/src/gpu-services log --oneline -1` shows the proxy commit.
- `git log --oneline` on `feature/blog-comments` shows the 10 feature/docs/test commits.

---

## Self-Review (completed during planning)

- **Spec coverage:** Moderation flow (Tasks 3,5,7) · async via jobs table (Tasks 3,5) · symon Ollama proxy LAN-IP (Tasks 2,10) · llama3.2:3b default (Task 3 `envClassifier`) · WP recovery approved-only/published/idempotent (Tasks 8,9) · name+email identity, email never templated (Tasks 1,4 — `author_email` not passed to `renderCommentList`) · one-level threading (Task 1 `assertTopLevelParent`, Task 4 nesting) · anti-abuse honeypot/min-time/rate-limit/length (Task 5) · display + moderation UI (Tasks 6,7) · config/docs/deferred (Task 10) · testing incl. e2e (all tasks + Task 11). All spec sections map to a task.
- **Spec deviation, called out:** the spec said "the job retries up to SPAM_MAX_ATTEMPTS"; the codebase's `jobs` table has no auto-retry, so retries live inside `spam-classifier.ts` (`maxAttempts` loop) and the handler fails safe to `queued`. Same observable behavior (bounded retries, unscored never auto-publishes); flagged here and in the handoff.
- **Placeholder scan:** no TBD/TODO; every code step has full code. Task 11 Step 1 intentionally instructs reading the existing e2e harness rather than reproducing it, because the runner pattern is repo-specific and must be matched, not invented — the assertions to make are enumerated.
- **Type consistency:** `ThreadComment`, `CommentRow`, `ModerationRow`, `ClassifyPayload`, `SpamVerdict`, `WpComment`, `WpFetcher` are defined once and imported consistently; `insertWebComment`/`insertImportedComment`/`getPostIdBySlug`/`listPublishedThread`/`listForModeration`/`applyClassification`/`setCommentStatus`/`getCommentById` signatures match across all call sites and tests.
