# Comment Email Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email the site owner about reader comments at an operator-selected level (off/ham/queued/all), via a fail-safe nodemailer job.

**Architecture:** A new `notify` job kind. `classify-handler` (and the too-fast-fill path) enqueue it gated by the persisted `commentNotify` Settings value; `notify-handler` loads the comment + post and sends a plain-text email through an env-configured, injectable, never-throwing `mailer`. Mirrors the existing `classify-handler`/`envClassifier()` + `teaserWords` config patterns.

**Tech Stack:** TypeScript (ESM, `--experimental-strip-types`), `node:sqlite`, Fastify, nodemailer, `node:test`.

Spec: `docs/superpowers/specs/2026-05-17-comment-email-notifications-design.md`. Anchors below were re-verified against current `main` (the spec's were ~32 commits stale).

**Verified anchors (current main):** `jobs.ts:45` `type JobKind = 'render' | 'classify'`; `JobHandlerCtx` (siteRoot + `[k]:unknown`) `jobs.ts:66`; `DEFAULT_HANDLERS` `jobs.ts:174-177`; `enqueue<P>(db,{kind,payload,cacheKey})` `jobs.ts:88`. `classify-handler.ts:37 makeClassifyHandler`; resolved status at `:51-55` (try) and `:58-63` (catch→queued); imports `applyClassification, getCommentById` from `comments.ts`. `comments.ts:98 getCommentById`→`CommentRow`, `:216 getPostIdBySlug`, `CommentStatus` `:8`. `config.ts` `SiteConfig:39`, `PersistedSiteConfig:73`, `pickPersistedFields:111`, `siteConfig():173`. `public-comments.ts` too-fast block (`if (tooFast) setCommentStatus(db,id,'queued'); else enqueue(...classify...)`). `server.ts:272` worker `ctx:{ siteRoot, db }`; `PUBLIC_BASE_URL` via `process.env`. `nodemailer` is ABSENT from deps.

---

### Task 1: Add `nodemailer` dependency

**Files:** Modify: `package.json` (+ lockfile)

- [ ] **Step 1: Add the dep**

Run: `npm install nodemailer@^6 && npm install -D @types/nodemailer@^6`
Expected: `package.json` `dependencies.nodemailer` + `devDependencies.@types/nodemailer` present; lockfile updated.

- [ ] **Step 2: Verify typecheck still clean**

Run: `npm run typecheck`
Expected: clean (no usage yet).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add nodemailer for comment email notifications"
```

---

### Task 2: `commentNotify` config plumbing

**Files:** Modify `src/lib/config.ts`; Test `test/lib/config.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/lib/config.test.ts` (mirror the existing `teaserWords` round-trip test in that file — match its `writePersistedSiteConfig`/`readPersistedSiteConfig`/`siteConfig` import names and tmp-root harness):

```ts
test('commentNotify round-trips; invalid value is dropped', () => {
  const root = freshConfigRoot();              // use the file's existing helper
  writePersistedSiteConfig(root, { commentNotify: 'queued' });
  assert.equal(readPersistedSiteConfig(root).commentNotify, 'queued');
  assert.equal(siteConfig(root).commentNotify, 'queued');
  writePersistedSiteConfig(root, { commentNotify: 'bogus' as never });
  assert.equal(readPersistedSiteConfig(root).commentNotify, undefined);
});
```

- [ ] **Step 2: Run → fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/config.test.ts`
Expected: FAIL (`commentNotify` not a known property / not persisted).

- [ ] **Step 3: Implement**

In `src/lib/config.ts`:

Add to `interface SiteConfig` (near `teaserWords?: number;`):
```ts
  /** Email-notification verbosity for new comments. */
  commentNotify?: 'off' | 'ham' | 'queued' | 'all';
```
Add the identical line to `interface PersistedSiteConfig` (near its `teaserWords?: number;`).

Add to `pickPersistedFields` (alongside the other `if (typeof r.X …)` lines, ~`config.ts:119-122`):
```ts
  if (
    r.commentNotify === 'off' || r.commentNotify === 'ham' ||
    r.commentNotify === 'queued' || r.commentNotify === 'all'
  ) {
    out.commentNotify = r.commentNotify;
  }
```

Add to `siteConfig()` (alongside the `if (persisted.teaserWords …)` surfacing, ~`config.ts:181-183`):
```ts
  if (persisted.commentNotify) out.commentNotify = persisted.commentNotify;
```
(Consumers default to `'ham'` via `?? 'ham'` — keeps the "surface only when set" pattern.)

- [ ] **Step 4: Run → passes**

Run: `npm run typecheck && node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/config.test.ts`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.ts test/lib/config.test.ts
git commit -m "feat(config): commentNotify level (off/ham/queued/all)"
```

---

### Task 3: `getPostMetaById` helper

**Files:** Modify `src/lib/comments.ts`; Test `test/lib/comments.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/lib/comments.test.ts` (mirror its existing seed harness — it already migrates a tmp db and inserts posts/comments; reuse those helpers):

```ts
test('getPostMetaById returns slug + title, undefined when absent', () => {
  const db = seededDb();                 // file's existing helper
  const postId = /* the id the helper inserted */ getPostIdBySlug(db, 'hello')!;
  assert.deepEqual(getPostMetaById(db, postId), { slug: 'hello', title: 'Hello' });
  assert.equal(getPostMetaById(db, 999999), undefined);
});
```

Match the seeded slug/title to whatever `test/lib/comments.test.ts` already inserts (read its top helper first).

- [ ] **Step 2: Run → fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/comments.test.ts`
Expected: FAIL (`getPostMetaById` not exported).

- [ ] **Step 3: Implement**

In `src/lib/comments.ts`, next to `getPostIdBySlug` (~`:216`):

```ts
export function getPostMetaById(
  db: Db,
  postId: number
): { slug: string; title: string } | undefined {
  return db
    .prepare<{ slug: string; title: string }>(
      'SELECT slug, title FROM posts WHERE id = ?'
    )
    .get(postId);
}
```

- [ ] **Step 4: Run → passes**

Run: `npm run typecheck && node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/comments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/comments.ts test/lib/comments.test.ts
git commit -m "feat(comments): getPostMetaById helper"
```

---

### Task 4: `src/lib/mailer.ts`

**Files:** Create `src/lib/mailer.ts`; Test `test/lib/mailer.test.ts`

- [ ] **Step 1: Write the failing test**

`test/lib/mailer.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeMailer } from '../../src/lib/mailer.ts';

test('no-op + sent:false when unconfigured', async () => {
  const m = makeMailer({ host: undefined, to: undefined }, async () => {
    throw new Error('transport must not be called when unconfigured');
  });
  assert.deepEqual(await m.sendMail({ to: 'x', subject: 's', text: 't' }), { sent: false });
});

test('configured: calls transport with the message, returns sent:true', async () => {
  const calls: unknown[] = [];
  const m = makeMailer(
    { host: 'smtp.example', port: 587, from: 'a@b', to: 'owner@b' },
    async (msg) => { calls.push(msg); }
  );
  const r = await m.sendMail({ to: 'owner@b', subject: 'S', text: 'B' });
  assert.deepEqual(r, { sent: true });
  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(calls[0]), /"subject":"S"/);
});

test('transport throw is swallowed → sent:false (never throws)', async () => {
  const m = makeMailer({ host: 'h', to: 'o' }, async () => { throw new Error('smtp down'); });
  assert.deepEqual(await m.sendMail({ to: 'o', subject: 's', text: 't' }), { sent: false });
});
```

- [ ] **Step 2: Run → fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/mailer.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/lib/mailer.ts`:

```ts
// Fail-safe SMTP sender for owner notifications. Mirrors the
// envClassifier() pattern in classify-handler.ts: lazy env read, no
// top-level side effects, never throws, no-ops when unconfigured.

import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}
export interface Mailer {
  sendMail(msg: MailMessage): Promise<{ sent: boolean }>;
}
interface SmtpConfig {
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  from?: string;
  to?: string;
}
type Transport = (msg: MailMessage & { from: string }) => Promise<void>;

let warned = false;
function warnOnce(m: string): void {
  if (warned) return;
  warned = true;
  process.stderr.write(`[mailer] ${m}\n`);
}

/** Pure constructor — config + transport injected (testable). */
export function makeMailer(cfg: SmtpConfig, transport: Transport): Mailer {
  return {
    async sendMail(msg) {
      if (!cfg.host || !cfg.to) {
        warnOnce('SMTP_HOST or NOTIFY_TO unset — notifications disabled');
        return { sent: false };
      }
      try {
        await transport({ ...msg, to: cfg.to, from: cfg.from ?? cfg.user ?? 'rkroll' });
        return { sent: true };
      } catch (err) {
        process.stderr.write(`[mailer] send failed: ${(err as Error).message}\n`);
        return { sent: false };
      }
    }
  };
}

/** Env-backed factory (reads process.env at call time, not import). */
export function envMailer(): Mailer {
  const e = process.env;
  const cfg: SmtpConfig = {
    host: e.SMTP_HOST,
    port: e.SMTP_PORT ? Number(e.SMTP_PORT) : 587,
    user: e.SMTP_USER,
    pass: e.SMTP_PASS,
    from: e.SMTP_FROM,
    to: e.NOTIFY_TO
  };
  const transport: Transport = async (m) => {
    const t = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465,
      ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.pass ?? '' } } : {})
    });
    await t.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text });
  };
  return makeMailer(cfg, transport);
}
```

- [ ] **Step 4: Run → passes**

Run: `npm run typecheck && node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/mailer.test.ts`
Expected: PASS (3).

- [ ] **Step 5: Commit**

```bash
git add src/lib/mailer.ts test/lib/mailer.test.ts
git commit -m "feat(mailer): fail-safe injectable SMTP sender"
```

---

### Task 5: `src/lib/notify-handler.ts`

**Files:** Create `src/lib/notify-handler.ts`; Test `test/lib/notify-handler.test.ts`

- [ ] **Step 1: Write the failing test**

`test/lib/notify-handler.test.ts` — seed a tmp db (mirror `test/lib/classify-handler.test.ts`'s db/seed harness: it migrates a tmp sqlite, inserts a post + a comment). Then:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeNotifyHandler } from '../../src/lib/notify-handler.ts';
// reuse classify-handler.test.ts's seed helpers (copy or import them)

test('published comment → email with permalink + admin link', async () => {
  const { db, commentId } = seedComment({ status: 'published', slug: 'hello', title: 'Hi', name: 'Ann' });
  const sent: unknown[] = [];
  const h = makeNotifyHandler({ sendMail: async (m) => { sent.push(m); return { sent: true }; } });
  process.env.PUBLIC_BASE_URL = 'https://ex.test';
  await h({ commentId }, { siteRoot: '/tmp', db });
  assert.equal(sent.length, 1);
  const m = sent[0] as { subject: string; text: string };
  assert.match(m.subject, /New comment on "Hi" by Ann/);
  assert.match(m.text, /https:\/\/ex\.test\/hello#comment-/);
  assert.match(m.text, /https:\/\/ex\.test\/admin\/comments/);
});

test('queued comment → moderation subject', async () => {
  const { db, commentId } = seedComment({ status: 'queued', slug: 'hello', title: 'Hi', name: 'Ann' });
  const sent: { subject: string }[] = [];
  const h = makeNotifyHandler({ sendMail: async (m) => { sent.push(m); return { sent: true }; } });
  await h({ commentId }, { siteRoot: '/tmp', db });
  assert.match(sent[0].subject, /\[moderation\] Held comment on "Hi" by Ann/);
});

test('missing/other-status comment → silent, no send', async () => {
  const { db } = seedComment({ status: 'pending', slug: 'hello', title: 'Hi', name: 'Ann' });
  let called = false;
  const h = makeNotifyHandler({ sendMail: async () => { called = true; return { sent: true }; } });
  await h({ commentId: 999999 }, { siteRoot: '/tmp', db });
  assert.equal(called, false);
});

test('ctx.db missing → throws (programmer error, like classify)', async () => {
  const h = makeNotifyHandler({ sendMail: async () => ({ sent: true }) });
  await assert.rejects(() => h({ commentId: 1 }, { siteRoot: '/tmp' }));
});
```

- [ ] **Step 2: Run → fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/notify-handler.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/lib/notify-handler.ts`:

```ts
// notify job handler: load comment + post, send the owner a
// plain-text email. Mirrors classify-handler.ts's ctx.db shape +
// defensive-return discipline. Never throws on mail failure (jobs.ts
// has no auto-retry — a thrown handler sits 'failed' forever).

import { getCommentById, getPostMetaById } from './comments.ts';
import type { Db } from './db.ts';
import type { Mailer } from './mailer.ts';

export interface NotifyPayload {
  commentId: number;
}

export function makeNotifyHandler(
  mailer: Mailer
): (p: NotifyPayload, ctx: { siteRoot: string; [k: string]: unknown }) => Promise<void> {
  return async (payload, ctx) => {
    const db = ctx.db as Db | undefined;
    if (!db) throw new Error('notify handler requires ctx.db');
    const c = getCommentById(db, payload.commentId);
    if (!c || (c.status !== 'published' && c.status !== 'queued')) return;
    const post = getPostMetaById(db, c.post_id);
    if (!post) return;
    const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
    const subject =
      c.status === 'queued'
        ? `[moderation] Held comment on "${post.title}" by ${c.author_name}`
        : `New comment on "${post.title}" by ${c.author_name}`;
    const text = [
      `${c.author_name} <${c.author_email}>`,
      `Post: ${post.title}`,
      '',
      c.body,
      '',
      `Comment: ${base}/${post.slug}#comment-${c.id}`,
      `Moderate: ${base}/admin/comments`
    ].join('\n');
    await mailer.sendMail({ to: '', subject, text });
  };
}
```

(`to` is set by the mailer from `NOTIFY_TO`; pass `''` — `makeMailer` overrides `to` with `cfg.to`.)

- [ ] **Step 4: Run → passes**

Run: `npm run typecheck && node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/notify-handler.test.ts`
Expected: PASS (4).

- [ ] **Step 5: Commit**

```bash
git add src/lib/notify-handler.ts test/lib/notify-handler.test.ts
git commit -m "feat(notify): notify-handler (per-status subject, fail-safe)"
```

---

### Task 6: Wire `notify` into the job system

**Files:** Modify `src/lib/jobs.ts`; Test `test/lib/jobs-handlers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/lib/jobs-handlers.test.ts` (mirror its existing `DEFAULT_HANDLERS`/handler-map assertions):

```ts
test('DEFAULT_HANDLERS includes a notify handler; JobKind accepts notify', () => {
  // DEFAULT_HANDLERS may be module-private; assert via enqueue + a
  // fake handler map instead if so (match the file's existing style).
  assert.ok(typeof makeNotifyHandler === 'function');
  const db = freshJobsDb();
  const r = enqueue(db, { kind: 'notify', payload: { commentId: 1 } });
  assert.ok(r.id > 0);
});
```

(If `DEFAULT_HANDLERS` isn't exported, the meaningful assertion is that `enqueue` accepts `kind:'notify'` — i.e. the `JobKind` widening compiles and a row is created. Match the file's existing harness.)

- [ ] **Step 2: Run → fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/jobs-handlers.test.ts`
Expected: FAIL (typecheck: `'notify'` not assignable to `JobKind`).

- [ ] **Step 3: Implement**

In `src/lib/jobs.ts`:
- Line 45: `type JobKind = 'render' | 'classify' | 'notify';`
- Add imports near the `classify-handler` import:
  ```ts
  import { makeNotifyHandler } from './notify-handler.ts';
  import { envMailer } from './mailer.ts';
  ```
- In `DEFAULT_HANDLERS` (~`:174-177`), add:
  ```ts
    notify: makeNotifyHandler(envMailer()) as JobHandler<unknown>
  ```

- [ ] **Step 4: Run → passes**

Run: `npm run typecheck && node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/jobs-handlers.test.ts test/lib/jobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/jobs.ts test/lib/jobs-handlers.test.ts
git commit -m "feat(jobs): register the notify job kind + handler"
```

---

### Task 7: Gate notify in `classify-handler`

**Files:** Modify `src/lib/classify-handler.ts`; Test `test/lib/classify-handler.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend `test/lib/classify-handler.test.ts`. It already runs the handler with a fake classifier + tmp db; add a helper to count queued `notify` jobs (`SELECT COUNT(*) FROM jobs WHERE kind='notify'`) and a way to set the level (write `config/site.json` under the tmp siteRoot, or stub `siteConfig`). Add cases:

```ts
test('level ham → notify on ham verdict only', async () => {
  setLevel(root, 'ham');
  await runClassify({ verdict: 'ham' });
  assert.equal(notifyCount(db), 1);
  await runClassify({ verdict: 'spam' });
  assert.equal(notifyCount(db), 1);          // unchanged
});
test('level queued → notify on spam/error only', async () => {
  setLevel(root, 'queued');
  await runClassify({ verdict: 'ham' });
  assert.equal(notifyCount(db), 0);
  await runClassify({ verdict: 'spam' });
  assert.equal(notifyCount(db), 1);
});
test('level all → both; level off → neither', async () => {
  setLevel(root, 'all');
  await runClassify({ verdict: 'ham' }); await runClassify({ verdict: 'spam' });
  assert.equal(notifyCount(db), 2);
  setLevel(root, 'off');
  await runClassify({ verdict: 'ham' }); await runClassify({ verdict: 'spam' });
  assert.equal(notifyCount(db), 2);          // unchanged
});
```

- [ ] **Step 2: Run → fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/classify-handler.test.ts`
Expected: FAIL (no notify jobs enqueued).

- [ ] **Step 3: Implement**

In `src/lib/classify-handler.ts`, add imports:
```ts
import { siteConfig } from './config.ts';
import { enqueue } from './jobs.ts';
```
Add a module-private helper:
```ts
function maybeNotify(db: Db, commentId: number, status: 'published' | 'queued'): void {
  const lvl = siteConfig().commentNotify ?? 'ham';
  const want =
    (status === 'published' && (lvl === 'ham' || lvl === 'all')) ||
    (status === 'queued' && (lvl === 'queued' || lvl === 'all'));
  if (want) enqueue(db, { kind: 'notify', payload: { commentId } });
}
```
In the `try` branch, replace the single `applyClassification(...)` call with the resolved status captured, then notify:
```ts
const status = v.verdict === 'ham' ? 'published' : 'queued';
applyClassification(db, payload.commentId, { status, score: v.score, reason: v.reason });
maybeNotify(db, payload.commentId, status);
```
In the `catch` branch, after `applyClassification(db, payload.commentId, { status: 'queued', … })`, add:
```ts
maybeNotify(db, payload.commentId, 'queued');
```
(Note: `jobs.ts` imports `classify-handler` for `DEFAULT_HANDLERS`, and now `classify-handler` imports `enqueue` from `jobs.ts`. `enqueue` is a top-level function with no import-time side effects, so this cycle is safe — but run the circular-import gate: `npm run circular`. If it flags, move `maybeNotify`'s `enqueue` call to import from a thin `jobs-enqueue` boundary; verify first, only refactor if the gate fails.)

- [ ] **Step 4: Run → passes (incl. circular gate)**

Run: `npm run typecheck && npm run circular && node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/classify-handler.test.ts`
Expected: PASS; no new circular dependency.

- [ ] **Step 5: Commit**

```bash
git add src/lib/classify-handler.ts test/lib/classify-handler.test.ts
git commit -m "feat(notify): gate classify→notify by commentNotify level"
```

---

### Task 8: Gate notify in the too-fast-fill path

**Files:** Modify `src/routes/public-comments.ts`; Test `test/routes/public-comments.test.ts` (or the file that covers the comment POST)

- [ ] **Step 1: Write the failing test**

In the public-comments route test (mirror its existing harness — it posts to `/:slug/comments`). Add: with `commentNotify` = `queued`, a too-fast submission (`t` timestamp within `MIN_FILL_MS`) enqueues a `notify` job; with level `ham` it does not.

```ts
test('too-fast fill → notify when level=queued, not when level=ham', async () => {
  // level=queued
  setLevel(root, 'queued');
  await postComment({ tooFast: true });
  assert.equal(jobCount(db, 'notify'), 1);
  // level=ham
  setLevel(root, 'ham');
  await postComment({ tooFast: true });
  assert.equal(jobCount(db, 'notify'), 1);     // unchanged
});
```

- [ ] **Step 2: Run → fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/routes/public-comments.test.ts`
Expected: FAIL (no notify on the too-fast path).

- [ ] **Step 3: Implement**

In `src/routes/public-comments.ts`, add `import { siteConfig } from '../lib/config.ts';` (if not present). In the `if (tooFast) { setCommentStatus(db, id, 'queued'); }` branch, add after `setCommentStatus`:
```ts
const lvl = siteConfig().commentNotify ?? 'ham';
if (lvl === 'queued' || lvl === 'all') {
  enqueue(db, { kind: 'notify', payload: { commentId: id } });
}
```
(`enqueue` is already imported in this file for the classify path.)

- [ ] **Step 4: Run → passes**

Run: `npm run typecheck && node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/routes/public-comments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/public-comments.ts test/routes/public-comments.test.ts
git commit -m "feat(notify): gate too-fast-fill→notify by commentNotify level"
```

---

### Task 9: Settings UI + route for `commentNotify`

**Files:** Modify `src/templates/admin-settings.ts`, `src/routes/admin-settings.ts`; Test `test/routes/admin-settings.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/routes/admin-settings.test.ts` (mirror its `teaserWords` GET-renders / POST-persists pair):

```ts
test('GET /admin/settings renders commentNotify select with persisted selected', async (t) => {
  const { app } = await setup(t);            // file's existing harness
  // persist commentNotify=queued first (writePersistedSiteConfig or POST)
  …
  const res = await app.inject({ method: 'GET', url: '/admin/settings' });
  assert.match(res.body, /name="commentNotify"/);
  assert.match(res.body, /<option value="queued"[^>]*selected/);
});

test('POST persists a valid commentNotify, ignores invalid', async (t) => {
  const { app, root } = await setup(t);
  await app.inject({ method: 'POST', url: '/admin/settings',
    payload: new URLSearchParams({ commentNotify: 'all', /* other required fields */ }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(readPersistedSiteConfig(root).commentNotify, 'all');
  await app.inject({ method: 'POST', url: '/admin/settings',
    payload: new URLSearchParams({ commentNotify: 'bogus', /* … */ }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(readPersistedSiteConfig(root).commentNotify, 'all'); // unchanged
});
```

Fill the `…`/`/* … */` by mirroring the existing `teaserWords` test in the same file (same `setup`, same required-field payload).

- [ ] **Step 2: Run → fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/routes/admin-settings.test.ts`
Expected: FAIL (no select / not persisted).

- [ ] **Step 3: Implement**

`src/templates/admin-settings.ts`:
- Add to the `persisted` object type (near `teaserWords?: number;` ~`:29`): `commentNotify?: 'off' | 'ham' | 'queued' | 'all';`
- In the `Posts` section (after the `teaserWords` input, before `<h2 …>Image uploads`), add (build `selected` per persisted value, default `ham`):
  ```ts
  `<h2 class="rkr-admin-settings-section">Comments</h2>
  <label for="rkr-settings-comment-notify">Email me about comments</label>
  <select id="rkr-settings-comment-notify" name="commentNotify">
    ${(['off','ham','queued','all'] as const).map((v) => {
      const label = { off:'Never', ham:'When auto-published', queued:'When held for moderation', all:'Any comment' }[v];
      const sel = (data.persisted.commentNotify ?? 'ham') === v ? ' selected' : '';
      return `<option value="${v}"${sel}>${label}</option>`;
    }).join('')}
  </select>`
  ```

`src/routes/admin-settings.ts`:
- Add `commentNotify?: unknown;` to the POST `Body` type (~`:104-115`, near `teaserWords?: unknown;`).
- After the existing field parses, before `writePersistedSiteConfig({...})`:
  ```ts
  const cn = body.commentNotify;
  const commentNotify =
    cn === 'off' || cn === 'ham' || cn === 'queued' || cn === 'all' ? cn : undefined;
  ```
- Add `...(commentNotify ? { commentNotify } : {})` into the `writePersistedSiteConfig({ … })` object (so an invalid/absent value leaves the persisted field unchanged — same partial-update semantics the route already documents).

- [ ] **Step 4: Run → passes**

Run: `npm run typecheck && node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/routes/admin-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/templates/admin-settings.ts src/routes/admin-settings.ts test/routes/admin-settings.test.ts
git commit -m "feat(settings): commentNotify level selector"
```

---

### Task 10: Docs (`secrets.env.example`) + spec status + full gate

**Files:** Modify `secrets.env.example`, `docs/superpowers/specs/2026-05-17-comment-email-notifications-design.md`, `docs/DEFERRED.md`

- [ ] **Step 1: secrets.env.example**

Append (with comments) the mail transport vars — feature is a clean no-op if unset:
```
# Comment email notifications (optional — unset = silently disabled).
# Level is chosen in /admin/settings (commentNotify), not here.
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
NOTIFY_TO=
```

- [ ] **Step 2: Spec status + DEFERRED**

In the spec, change the Status line to `Status: Implemented 2026-05-17`. In `docs/DEFERRED.md`, delete the `**Email notifications on new/queued comments**` bullet (Comments section) — it shipped.

- [ ] **Step 3: Full gate**

Run: `npm run typecheck` then `node --test --no-warnings=ExperimentalWarning --experimental-strip-types 'test/**/*.test.ts'` then `npm run lint && npm run circular`
Expected: typecheck clean; all tests pass; biome clean; no circular deps.

- [ ] **Step 4: Commit**

```bash
git add secrets.env.example docs/superpowers/specs/2026-05-17-comment-email-notifications-design.md docs/DEFERRED.md
git commit -m "docs(notify): secrets.env.example + mark spec shipped, drop DEFERRED"
```

---

## Self-Review

**Spec coverage:** mailer (Task 4) ↔ spec §`mailer.ts`; notify-handler per-status (Task 5) ↔ §`notify-handler.ts` + Email content; jobs wiring (Task 6) ↔ §`jobs.ts`; level gating in classify + too-fast (Tasks 7–8) ↔ §classify-handler + §public-comments + §Data flow; Settings level (Tasks 2, 9) ↔ §Notification level (Settings) + §Configuration; nodemailer (Task 1) ↔ §package.json; secrets/env (Task 10) ↔ §Configuration; testing per task ↔ §Testing. Non-goals (HTML mail, digests, manual-approve notify, per-post toggles) are not implemented — correct. No gaps.

**Placeholder scan:** Test steps that say "mirror the file's existing harness" / `…` (Tasks 2,3,7,8,9) are deliberate: those test files have bespoke seed/setup helpers not quoted here; the executor must read each test file's top and reuse its helpers rather than invent parallel ones. Each such step still states the exact assertions. Implementation steps all contain complete code.

**Type/consistency:** `Mailer`/`MailMessage`/`makeMailer`/`envMailer` (Task 4) consumed unchanged in Tasks 5–6. `makeNotifyHandler(mailer)` signature matches its jobs.ts registration (Task 6) and its tests (Task 5). `commentNotify: 'off'|'ham'|'queued'|'all'` identical across config (2), template/route (9), and the `maybeNotify` gate (7) + too-fast gate (8); default `?? 'ham'` applied consistently at every consumer. `getPostMetaById(db,postId) → {slug,title}|undefined` defined in 3, used in 5. JobKind widening (6) is the prerequisite for the `enqueue(...,{kind:'notify'})` calls in 7/8 — Task order respects that. Circular-import risk (classify-handler ↔ jobs) explicitly gated in Task 7 Step 4.
