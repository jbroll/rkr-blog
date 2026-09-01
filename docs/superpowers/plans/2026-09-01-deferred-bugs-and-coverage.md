# Deferred Bugs and Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four live correctness bugs recorded in `docs/DEFERRED.md`, wire the already-written `requireOwner` guard to the routes that need it, and close the two test-coverage gaps that are not blocked on missing infrastructure.

**Architecture:** Three phases, ordered by user-visible risk. Phase 1 fixes data-corrupting and data-stranding bugs (WordPress dump literal parsing, the future-mtime save wedge, the outbox drain race). Phase 2 wires role enforcement to owner-only routes. Phase 3 adds the PWA end-to-end smoke test and closes the `preview-page.ts` default-options coverage hole. Each task ends with a commit and is independently reviewable.

**Tech Stack:** TypeScript (ESM, `--experimental-strip-types`), Fastify 5, better-sqlite3, OPFS + Web Locks in the browser layer, `node:test` + `node:assert/strict` for unit tests, Playwright for e2e, c8 + monocart for coverage, biome for lint, lefthook + org-hooks for the commit gate.

## Global Constraints

- **Unit tests are `node:test`, not vitest.** There is no vitest in this repo. Import `assert from 'node:assert/strict'` and `{ test, beforeEach } from 'node:test'`.
- **Relative imports carry the `.ts` extension.** Every one, including in tests.
- **Playwright specs must import from `./coverage-fixtures.ts`**, never from `@playwright/test`. A spec importing the latter contributes no V8 coverage (`docs/TESTING.md:22`).
- **Playwright config:** `test/playwright.config.ts`, `testDir: './e2e'`, `testMatch: /.*\.spec\.ts$/`, `fullyParallel: false`, `workers: 1`, `retries: 1`, per-test `timeout: 30_000`, `globalTimeout: 8 * 60_000`. Base URL `http://127.0.0.1:3789`.
- **No `page.waitForTimeout` in specs.** Use `Promise.all([page.waitForURL(...), action()])` or web-first assertions.
- **Production source under `src/` and `bin/` has a 500-line size cap.** Tests are exempt (`TEST_SIZE_CAP=100000` in `lefthook-rc.sh:9`). `src/routes/admin.ts` is already at its cap — do not add net lines to it; extract instead.
- **The commit gate is lefthook + org-hooks, not `.githooks/pre-commit`.** That path does not exist; `CLAUDE.md` is stale about it. The gate runs hygiene, secrets, format-lint, dup-types, no-reexports, size-caps, typecheck, knip, circular, then `ci/test` and `ci/e2e` in parallel with the union coverage ratchet.
- **`npm run type-check` (hyphenated) is the one that typechecks e2e specs.** `npm run typecheck` (no hyphen) omits `tsconfig.e2e.json`. Run the hyphenated one after touching any spec.
- **Do not reseed the coverage baseline as a side effect.** `coverage-union-baseline.json` is reseeded only in the dedicated final task, and only with `--reseed` (per-file max), never `--seed`.
- **Do not add more of `packages/image-edit/src/canvas/**` to `coverage:ungated`** (`docs/TESTING.md:287-291`) — the union denominator grows faster than the covered count and every canvas file's percentage drops.
- No changelog. Docs change in the same commit as the code.

## Scope

**In scope** (7 tasks): WP dump literal parsing; the future-mtime CAS wedge in both posts and sidecars; the outbox drain race; `requireOwner` wiring; the image-pwa Playwright smoke; `preview-page.ts` coverage; the docs/DEFERRED/baseline sweep.

**Deliberately not in scope**, with the reason each stays in `docs/DEFERRED.md`:

- **Playwright coverage of the Google OAuth callback.** `src/routes/auth.ts` is at 94.36% and the callback has nine `app.inject` tests in `test/routes/auth.test.ts` (lines 151, 175, 208, 231, 245, 262, 274, 293, 305). The e2e server has dummy OAuth wiring only (`test/e2e/server-runner.ts:29-34`). A browser-level test would need a stub identity provider to add nothing the injection tests do not already assert.
- **Perspective-modal WebGL UI** (`packages/image-edit/src/canvas/perspective-modal.ts`, baseline 1.43%). Genuinely blocked on a stable headless WebGL path or a Canvas2D fallback. Its math counterpart `core/canvas-math.ts` is already at 100%.
- **`buildImageMapFromOpfs` blob: URLs never revoked.** Not a defect. Every URL it mints must outlive the rendered document and the preview renders once per page load, so there is nothing to revoke. Task 6 covers the code path; the note stays as-is.
- **Everything trigger-gated**: multi-tenant infra, roles UI, theme picker, per-instance crops, per-image captions, cross-figure move, module singletons, per-process scaling, SW `networkFirst` fallback.

---

### Task 1: WordPress dump — decode binary and hex literals

**Files:**
- Modify: `src/lib/wp-dump.ts:163-217` (`parseValues`, `bareValue`)
- Test: `test/lib/wp-dump.test.ts` (append)

**Model:** `sonnet` — parser surgery with several interacting cases; the fix is described precisely but not transcribable verbatim.

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks rely on. `Cell` stays `string | number | null` plus a new `Uint8Array` member: `type Cell = string | number | Uint8Array | null;`

**Background.** Two independent defects in the same function.

The first is a missing reset. In `parseValues`, hitting `'` at line 175 sets `quoted = true` and advances, but never clears `field`. Any characters accumulated before the quote survive and get prepended to the decoded string. So `_binary'…'` stores `"_binary" + contents`. This is not blob-specific: `_utf8mb4'…'` and `N'…'` are charset introducers on ordinary text and are mangled identically. Real damage seen downstream: a literal `_binary` prefix on `blogname`, a broken `_wp_attached_file` path, and `_thumbnail_id` parsing to `NaN` at `src/lib/wp-sqlite.ts:180`, which silently drops the featured image.

The second is `bareValue` (line 211): `0x4142` fails both numeric regexes and falls to `return tok`, storing the hex source text rather than the two bytes.

Note the DDL side is already correct — `TYPE_MAP` at `wp-dump.ts:17-21` maps `blob|binary|varbinary` to `BLOB`. Only values are wrong.

- [ ] **Step 1: Write the failing tests**

Append to `test/lib/wp-dump.test.ts`. `POSTS_DDL` (line 30) has no binary column, so the blob case needs its own DDL.

```ts
// ---- binary and charset-introducer literals ----

test('convertDump: _binary introducer is stripped, not prefixed onto the value', (t) => {
  const { db } = convert(
    t,
    `${POSTS_DDL}
INSERT INTO \`wp_posts\` VALUES (1,_binary'My Blog','body',0,NULL);
`
  );
  const row = db
    .prepare<{ post_title: string }>('SELECT post_title FROM wp_posts WHERE ID = 1')
    .get();
  assert.equal(row?.post_title, 'My Blog');
});

test('convertDump: charset introducers N and _utf8mb4 are stripped', (t) => {
  const { db } = convert(
    t,
    `${POSTS_DDL}
INSERT INTO \`wp_posts\` VALUES (1,_utf8mb4'Caf\\u00e9','x',0,NULL),(2,N'Plain','y',0,NULL);
`
  );
  const rows = db
    .prepare<{ ID: number; post_title: string }>(
      'SELECT ID, post_title FROM wp_posts ORDER BY ID'
    )
    .all();
  assert.equal(rows[0]?.post_title, 'Café');
  assert.equal(rows[1]?.post_title, 'Plain');
});

test('convertDump: _binary with a space before the quote is also stripped', (t) => {
  const { db } = convert(
    t,
    `${POSTS_DDL}
INSERT INTO \`wp_posts\` VALUES (1,_binary 'Spaced','x',0,NULL);
`
  );
  const row = db
    .prepare<{ post_title: string }>('SELECT post_title FROM wp_posts WHERE ID = 1')
    .get();
  assert.equal(row?.post_title, 'Spaced');
});

test('convertDump: 0x hex literal lands in a BLOB column as bytes', (t) => {
  const { db } = convert(
    t,
    `CREATE TABLE \`wp_blobs\` (
  \`ID\` bigint(20) unsigned NOT NULL,
  \`payload\` longblob
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO \`wp_blobs\` VALUES (1,0x4142),(2,0x),(3,NULL);
`
  );
  const rows = db
    .prepare<{ ID: number; payload: Uint8Array | null }>(
      'SELECT ID, payload FROM wp_blobs ORDER BY ID'
    )
    .all();
  assert.deepEqual(Array.from(rows[0]?.payload ?? []), [0x41, 0x42]);
  assert.equal(rows[0] && typeof rows[0].payload, 'object');
  assert.deepEqual(Array.from(rows[1]?.payload ?? []), []);
  assert.equal(rows[2]?.payload, null);
});

test('convertDump: an odd-length or malformed hex literal stays a string', (t) => {
  const { db } = convert(
    t,
    `${POSTS_DDL}
INSERT INTO \`wp_posts\` VALUES (1,'t',0xABC,0,NULL),(2,'u',0xZZ,0,NULL);
`
  );
  const rows = db
    .prepare<{ ID: number; post_content: string }>(
      'SELECT ID, post_content FROM wp_posts ORDER BY ID'
    )
    .all();
  assert.equal(rows[0]?.post_content, '0xABC');
  assert.equal(rows[1]?.post_content, '0xZZ');
});

test('convertDump: a bare identifier before a quote is still not swallowed', (t) => {
  // Guards the reset: only a known introducer is dropped, and the
  // reset must not eat a value that legitimately abuts a quote.
  const { db } = convert(
    t,
    `${POSTS_DDL}
INSERT INTO \`wp_posts\` VALUES (1,'a''b','x',0,NULL);
`
  );
  const row = db
    .prepare<{ post_title: string }>('SELECT post_title FROM wp_posts WHERE ID = 1')
    .get();
  assert.equal(row?.post_title, "a'b");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npm test -- --test-name-pattern='binary|charset|hex|identifier before a quote'
```
Expected: FAIL. The `_binary` case asserts `'My Blog'` and receives `'_binaryMy Blog'`. The hex case asserts bytes and receives the string `'0x4142'`.

- [ ] **Step 3: Add the introducer reset in `parseValues`**

In `src/lib/wp-dump.ts`, replace the quote branch at line 175:

```ts
      if (c === "'") {
        quoted = true;
        i++;
```

with:

```ts
      if (c === "'") {
        // A charset introducer (_binary, _utf8mb4, N, …) abuts the
        // opening quote. Without this reset it is prepended to the
        // decoded value — `_binary` ends up in post titles and
        // attachment paths.
        if (INTRODUCER.test(field)) field = '';
        quoted = true;
        i++;
```

Add the pattern near `UNESCAPE` (line 147):

```ts
/** MySQL charset introducers and the binary marker that may precede a
 * quoted literal. `N'…'` is the SQL-standard national-character form. */
const INTRODUCER = /^(?:_[A-Za-z0-9]+|N)$/;
```

Note the trailing-space form (`_binary '…'`) already works with this, because the space branch at line 199 skips the space without touching `field`, so `field` still holds exactly `_binary` when the quote arrives.

- [ ] **Step 4: Decode hex literals in `bareValue`**

Widen the `Cell` type at `src/lib/wp-dump.ts:159`:

```ts
type Cell = string | number | Uint8Array | null;
```

Then replace `bareValue` (lines 211-217) with:

```ts
function bareValue(raw: string): Cell {
  const tok = raw.trim();
  if (tok.toUpperCase() === 'NULL' || tok === '') return null;
  if (/^0x(?:[0-9a-fA-F]{2})*$/.test(tok)) return hexBytes(tok.slice(2));
  if (/^-?\d+$/.test(tok)) return Number(tok);
  if (/^-?[\d.]+(e[-+]?\d+)?$/i.test(tok)) return Number(tok);
  return tok;
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let n = 0; n < out.length; n++) {
    out[n] = Number.parseInt(hex.slice(n * 2, n * 2 + 2), 16);
  }
  return out;
}
```

The regex requires an even digit count, so `0xABC` and `0xZZ` fall through to `return tok` and stay strings — mysqldump never emits an odd-length hex literal, and guessing at one would corrupt data silently.

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
npm test -- --test-name-pattern='wp-dump|convertDump'
```
Expected: PASS, including the ~19 pre-existing `convertDump` tests. If the escape/delimiter test at the existing `handles escapes, embedded delimiters and NULL` case fails, the introducer reset is too greedy — check that `INTRODUCER` is anchored at both ends.

- [ ] **Step 6: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: clean. `insert.run(...row)` in `convertDump` (line 291) accepts `Uint8Array` as a better-sqlite3 blob binding, so no cast is needed; if `tsc` disagrees, widen the binding type rather than casting the value.

- [ ] **Step 7: Commit**

```bash
git add src/lib/wp-dump.ts test/lib/wp-dump.test.ts
git commit -m "fix(wp-dump): decode binary and hex literals instead of storing them as text

A charset introducer abutting a quoted literal was prepended to the
decoded value, so _binary/_utf8mb4/N leaked into post titles,
attachment paths and _thumbnail_id. 0x literals were stored as their
source text."
```

---

### Task 2: Compare-and-swap the save baseline instead of clamping it

**Files:**
- Create: `src/routes/post-base.ts`
- Modify: `src/routes/admin.ts:291-330` (replace the inline guard with a call)
- Modify: `src/routes/sidecar-base.ts:73-76` (same fix, second site)
- Test: `test/routes/admin-posts.test.ts:192` and `:241` (rewrite), plus new cases
- Test: `test/routes/sidecar-base.test.ts` (append; create if absent)

**Model:** `opus` — data-safety correctness, a deliberate behavior change, and two call sites that must stay consistent.

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `src/routes/post-base.ts` exporting

```ts
export type BaseVerdict =
  | { kind: 'no-baseline' }
  | { kind: 'invalid' }
  | { kind: 'superseded'; serverUpdatedAt: string }
  | { kind: 'ok' };

export function postUpdatedAt(mtimeMs: number): string;
export function evaluatePostBase(header: string | undefined, mtimeMs: number): BaseVerdict;
```

Task 6 does not depend on this. No later task imports it.

**Background and the design decision.** `src/routes/admin.ts:307-330` clamps the client's claimed baseline to now:

```ts
      const clampedLastSyncedMs = Math.min(lastSyncedMs, Date.now());
      const serverMtimeMs = Math.floor(fs.statSync(finalPath).mtimeMs);
      if (serverMtimeMs > clampedLastSyncedMs) {
```

When `serverMtimeMs > Date.now()` — a future-dated file from clock skew or a restored backup — the clamp makes the comparison true for every possible header value, including the `serverUpdatedAt` the server itself just returned in the 409 body. The slug wedges with no in-app escape. `src/routes/sidecar-base.ts:73-76` repeats the same clamp and has the same wedge for image sidecars.

The clamp exists to stop a client bypassing the `>` test by claiming the future. **Replacing the inequality with exact equality removes the need for the clamp entirely**: a client cannot forge a match forward, because the only way to learn the real mtime is to be told it in the 409 body. This is a genuine compare-and-swap and needs no new header.

The behavior change: a header strictly *newer* than the file's mtime now 409s where it previously passed. This is correct — it means the client's baseline does not describe the file on disk. Legitimate clients echo back the exact `updatedAt` the server handed them (`admin.ts:353`), and the byte-identical no-op layer at `admin.ts:270-289` returns 200 before the guard is reached, so no real flow regresses.

- [ ] **Step 1: Write the failing test for the wedge**

The e2e helper `POST /admin/test/bump-mtime/:slug` (`test/e2e/server-runner.ts:52-77`) takes an `offsetMs`, but this is a route-injection test, so set mtime directly. Append to `test/routes/admin-posts.test.ts`:

```ts
test('POST /admin/posts: a future-dated mtime is recoverable by echoing serverUpdatedAt', async (t) => {
  const { root, app } = await setup(t);
  const payload = {
    slug: 'wedged',
    title: 'v1',
    status: 'draft',
    date: '2026-01-01',
    markdown: 'body'
  };
  const first = await app.inject({ method: 'POST', url: '/admin/posts', payload });
  assert.equal(first.statusCode, 200, first.body);

  const filePath = path.join(root, 'content', 'posts', 'wedged.md');
  const future = Date.now() + 60_000;
  fs.utimesSync(filePath, new Date(future), new Date(future));

  // A stale baseline still 409s, and the body tells the client the truth.
  const conflict = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: { 'x-rkr-last-synced-at': new Date(Date.now() - 1000).toISOString() },
    payload: { ...payload, title: 'v2' }
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  const { serverUpdatedAt } = JSON.parse(conflict.body) as { serverUpdatedAt: string };

  // Echoing it back is the escape hatch the clamp used to deny.
  const ok = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: { 'x-rkr-last-synced-at': serverUpdatedAt },
    payload: { ...payload, title: 'v2' }
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.match(fs.readFileSync(filePath, 'utf8'), /title: v2/);
});

test('POST /admin/posts: a baseline newer than mtime is a conflict, not a pass', async (t) => {
  const { root, app } = await setup(t);
  const payload = {
    slug: 'ahead',
    title: 'v1',
    status: 'draft',
    date: '2026-01-01',
    markdown: 'body'
  };
  await app.inject({ method: 'POST', url: '/admin/posts', payload });
  const filePath = path.join(root, 'content', 'posts', 'ahead.md');
  const mtime = Math.floor(fs.statSync(filePath).mtimeMs);

  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: { 'x-rkr-last-synced-at': new Date(mtime + 5000).toISOString() },
    payload: { ...payload, title: 'v2' }
  });
  assert.equal(res.statusCode, 409, res.body);
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
npm test -- --test-name-pattern='future-dated mtime is recoverable|newer than mtime'
```
Expected: the first FAILs at the final assertion with `409` instead of `200`. The second currently PASSES-by-accident is not possible — it FAILs with `200`, because `>` lets a newer baseline through today.

- [ ] **Step 3: Extract the verdict module**

`src/routes/admin.ts` is at its 500-line size cap, so the logic moves out rather than growing in place. Create `src/routes/post-base.ts`, mirroring the shape of the existing `src/routes/sidecar-base.ts`:

```ts
/** Compare-and-swap for the post save baseline. The client must echo
 * the exact updatedAt it was last given; a mismatch in either
 * direction is a conflict. Exact equality is what lets a future-dated
 * mtime be recovered in-app — a clamped inequality 409s forever
 * because no header value can ever satisfy it. */

/** Whole-ms ISO, matching what the save route echoes back. mtimeMs is
 * a sub-ms float on some filesystems and the header round-trips
 * through Date.parse, so both sides must floor. */
export function postUpdatedAt(mtimeMs: number): string {
  return new Date(Math.floor(mtimeMs)).toISOString();
}

export type BaseVerdict =
  | { kind: 'no-baseline' }
  | { kind: 'invalid' }
  | { kind: 'superseded'; serverUpdatedAt: string }
  | { kind: 'ok' };

export function evaluatePostBase(
  header: string | undefined,
  mtimeMs: number
): BaseVerdict {
  if (typeof header !== 'string') return { kind: 'no-baseline' };
  const claimedMs = Date.parse(header);
  if (Number.isNaN(claimedMs)) return { kind: 'invalid' };
  const serverMs = Math.floor(mtimeMs);
  if (serverMs !== claimedMs) {
    return { kind: 'superseded', serverUpdatedAt: postUpdatedAt(serverMs) };
  }
  return { kind: 'ok' };
}
```

- [ ] **Step 4: Call it from the save route**

In `src/routes/admin.ts`, replace the whole block at lines 291-330 (the comment beginning `// Clamp the client's claim to "now"` through the closing brace of the `if`) with:

```ts
    const lastSyncedAtRaw = request.headers['x-rkr-last-synced-at'];
    if (!inserted) {
      const verdict = evaluatePostBase(
        typeof lastSyncedAtRaw === 'string' ? lastSyncedAtRaw : undefined,
        fs.statSync(finalPath).mtimeMs
      );
      if (verdict.kind === 'invalid') {
        return reply
          .code(400)
          .send({ error: 'X-Rkr-Last-Synced-At must be an ISO-8601 timestamp' });
      }
      if (verdict.kind === 'superseded') {
        return reply.code(409).send({
          error: 'post-superseded',
          slug,
          serverUpdatedAt: verdict.serverUpdatedAt,
          clientLastSyncedAt: lastSyncedAtRaw
        });
      }
    }
```

Add the import at the top of `src/routes/admin.ts` alongside the other route-local imports:

```ts
import { evaluatePostBase } from './post-base.ts';
```

Then use the shared serializer at line 353 so the echoed value and the guard can never drift:

```ts
    const updatedAt = postUpdatedAt(fs.statSync(finalPath).mtimeMs);
```

extending the import to `import { evaluatePostBase, postUpdatedAt } from './post-base.ts';`.

- [ ] **Step 5: Apply the same fix to sidecars**

In `src/routes/sidecar-base.ts`, the clamp is at line 73 and the compare at line 76. Replace the clamp-and-compare pair so the function returns `'superseded'` on inequality rather than on `serverMs > clampedMs`:

```ts
  const serverMs = Math.floor(mtimeMs);
  if (serverMs !== claimedMs) {
    return { kind: 'superseded', serverUpdatedAt: sidecarUpdatedAt(mtimeMs) };
  }
```

Delete the now-unused `Math.min(clientBaseMs, Date.now())` line and any comment that explains the clamp. Read the surrounding function first — the local variable names differ from the post route's and the existing verdict union already has the `'superseded'` member with this shape.

- [ ] **Step 6: Rewrite the two tests that encode the old semantics**

`test/routes/admin-posts.test.ts:192` is named `'POST /admin/posts: future-dated X-Rkr-Last-Synced-At still 409s (clamped)'` and asserts the wedge. Replace it with a test of what remains true — a future-dated header that does not match mtime is still a conflict:

```ts
test('POST /admin/posts: a future-dated X-Rkr-Last-Synced-At that does not match still 409s', async (t) => {
  const { root, app } = await setup(t);
  const payload = {
    slug: 'skewed',
    title: 'v1',
    status: 'draft',
    date: '2026-01-01',
    markdown: 'body'
  };
  await app.inject({ method: 'POST', url: '/admin/posts', payload });
  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: { 'x-rkr-last-synced-at': new Date(Date.now() + 86_400_000).toISOString() },
    payload: { ...payload, title: 'v2' }
  });
  assert.equal(res.statusCode, 409, res.body);
});
```

`test/routes/admin-posts.test.ts:241` (`'force-overwrite (no header) bypasses the conflict guard'`) still passes unchanged — omitting the header yields `'no-baseline'`, which is not a rejection. Leave it, but read it to confirm.

- [ ] **Step 7: Run the full route and sidecar suites**

Run:
```bash
npm test -- --test-name-pattern='admin-posts|sidecar|outbox-idempotency'
```
Expected: PASS. Pay attention to `test/routes/admin-outbox-idempotency.test.ts:141` (genuine-divergence 409) — it must still 409.

- [ ] **Step 8: Update the offline spec doc**

`docs/spec-offline.md:334-337` still says force is "re-POST … without the `X-Rkr-Last-Synced-At` header", which the client stopped doing when `forceConflictedSave` began sending the baseline (`src/admin/sync.ts:211`). Correct that paragraph to describe the CAS: the client re-sends the exact `serverUpdatedAt` it was shown, and a third write landing in the gap 409s again with a fresh value. Also drop `docs/backlog.md:40` if it tracks the same drift.

- [ ] **Step 9: Run the e2e conflict specs**

Run:
```bash
npm run build:admin && npm run build:site && npx playwright test --config test/playwright.config.ts test/e2e/editor-flow.spec.ts
```
Expected: PASS, in particular the conflict-and-force block at `editor-flow.spec.ts:1512` and the "third write lands in the gap → force 409s again" assertion at `:1560-1578`.

- [ ] **Step 10: Commit**

```bash
git add src/routes/post-base.ts src/routes/admin.ts src/routes/sidecar-base.ts \
        test/routes/admin-posts.test.ts docs/spec-offline.md docs/backlog.md
git commit -m "fix(save): compare-and-swap the baseline instead of clamping it

A future-dated mtime made the clamped inequality true for every
possible header value, so the slug 409'd forever with no in-app
escape. Exact equality is forgery-proof without the clamp and lets a
client recover by echoing the serverUpdatedAt it was handed. Same fix
for image sidecars, which repeated the clamp."
```

---

### Task 3: Close the outbox drain race

**Files:**
- Modify: `src/admin/sync.ts:259-276` (`tryDrain`) and `:311-368` (`drainLoop` tail)
- Test: `test/admin/sync-drain-race.test.ts` (create)

**Model:** `opus` — concurrency correctness against a Web Locks mock; getting the re-check window wrong reintroduces the bug silently.

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: no signature changes. `tryDrain(): Promise<void>` keeps its shape.

**Background — the window is narrower than `DEFERRED.md` says.** `drainLoop` re-lists on every iteration (`const entries = await outboxList()` at `sync.ts:321`, `remaining = (await outboxList()).length` at `:350`), so an entry appended *mid-loop* is picked up. The actual gap is between the final `remaining === 0` check and the Web Lock releasing, and it is stretched by `await runEviction()` at `sync.ts:363-367`, which is slow OPFS work. An `append` + `tryDrain` landing in that gap sees the lock still held, `lock === null`, returns, and nothing re-triggers. There is no periodic sweep anywhere: `PROBE_INTERVAL_MS` in `src/admin/online-state.ts:12` only re-polls *while offline* and stops on success.

The fix is to re-check emptiness inside the lock, after eviction, and loop. This is cross-tab safe because OPFS is the shared source of truth, unlike a module-level dirty flag. Two guards are mandatory:

1. `drainLoop` early-returns on `halted` and `conflict` (`sync.ts:326-328`, `:337`, `:342`) *without* publishing `idle`. A re-check must not spin against a halted or conflicted head — gate on `getStatus()` (`sync.ts:138`).
2. `drainEntryWithRetry` deliberately breaks out when offline (`sync.ts:405`) on the assumption that the online listener re-triggers. Gate the re-check on `getOnlineState() === 'online'`.

- [ ] **Step 1: Write the failing test**

Create `test/admin/sync-drain-race.test.ts`. `test/admin/opfs-mock.ts:271-304` already ships a `MockLockManager` whose docstring says it is faithful enough to exercise the `ifAvailable` guard — `{ ifAvailable: true }` against a held lock invokes the callback with `null` and does not queue. Follow the `test/admin/startup-races.test.ts` idiom: `installMockOpfs()` at module level, then dynamic `await import()` inside the test body.

```ts
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { installMockOpfs } from './opfs-mock.ts';

const { resetMockOpfs } = installMockOpfs();

beforeEach(() => resetMockOpfs());

test('tryDrain: an entry appended while the leader is finishing is not stranded', async () => {
  const { append, list } = await import('../../src/admin/outbox.ts');
  const { tryDrain } = await import('../../src/admin/sync.ts');

  // Make the drain observably slow so the append lands in the window
  // between the loop's last emptiness check and the lock releasing.
  const drained: number[] = [];
  globalThis.fetch = (async (url: string) => {
    drained.push(drained.length);
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  await append({ op: 'savePost', slug: 'a', payload: { title: 'a' } });
  const leader = tryDrain();

  // Second entry arrives while the leader still holds the lock; its
  // own tryDrain is a no-op because the lock is unavailable.
  await new Promise((r) => setTimeout(r, 5));
  await append({ op: 'savePost', slug: 'b', payload: { title: 'b' } });
  await tryDrain();

  await leader;
  assert.deepEqual(await list(), [], 'outbox should be empty after the leader settles');
});
```

Read `test/admin/startup-races.test.ts` and `test/admin/opfs-mock.ts` before writing this — the exact `append` payload shape and the fetch stubbing convention must match what the mock and `drainers.ts` expect. Adjust the op/payload to a shape `drainSavePost` (`src/admin/drainers.ts:120-153`) actually accepts.

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
npm test -- test/admin/sync-drain-race.test.ts
```
Expected: FAIL — `list()` returns one entry (`slug: 'b'`), because the leader published `idle` and released without rechecking.

- [ ] **Step 3: Re-check inside the lock**

In `src/admin/sync.ts`, change `tryDrain` (lines 265-276) so the leader loops until the queue is genuinely empty:

```ts
export function tryDrain(): Promise<void> {
  /* v8 ignore next 3 -- Web Locks is universal where OPFS is */
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return Promise.resolve();
  }
  return navigator.locks
    .request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      // Re-check before releasing. A tryDrain that arrived while we
      // held the lock was a no-op, and nothing else re-triggers it —
      // there is no periodic sweep. Bounded so a permanently
      // re-filling queue can't pin the lock.
      for (let pass = 0; pass < MAX_DRAIN_PASSES; pass++) {
        await drainLoop();
        if (getStatus().kind !== 'idle') return;
        if (getOnlineState() !== 'online') return;
        if ((await outboxList()).length === 0) return;
      }
    })
    .then(() => {});
}
```

Add the bound next to the existing retry constants at `sync.ts:302-309`:

```ts
const MAX_DRAIN_PASSES = 8;
```

Check that `getOnlineState` is already imported in `sync.ts` — `drainEntryWithRetry` uses it at line 405, so it should be. `outboxList` and `getStatus` are both in scope.

- [ ] **Step 4: Move the emptiness check past eviction**

The re-check in Step 3 runs after `drainLoop` returns, and `drainLoop` already ends with `await runEviction()` at `sync.ts:363-367`. Read the tail of `drainLoop` and confirm eviction is inside it. If eviction sits outside the loop in the caller instead, move the Step 3 re-check to after the eviction call, otherwise the widest part of the window stays open.

- [ ] **Step 5: Run to verify it passes**

Run:
```bash
npm test -- test/admin/sync-drain-race.test.ts
```
Expected: PASS.

- [ ] **Step 6: Verify no spin against halted or conflicted state**

Add a second test in the same file asserting the loop stops:

```ts
test('tryDrain: a conflicted head does not spin the re-check loop', async () => {
  const { append } = await import('../../src/admin/outbox.ts');
  const { tryDrain, getStatus } = await import('../../src/admin/sync.ts');

  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ error: 'post-superseded' }), { status: 409 });
  }) as typeof fetch;

  await append({ op: 'savePost', slug: 'c', payload: { title: 'c' } });
  await tryDrain();

  assert.equal(getStatus().kind, 'conflict');
  assert.ok(calls <= 2, `expected the loop to stop on conflict, saw ${calls} attempts`);
});
```

Run:
```bash
npm test -- test/admin/sync-drain-race.test.ts
```
Expected: PASS both.

- [ ] **Step 7: Run the offline e2e suite**

Run:
```bash
npm run build:admin && npm run build:site && \
  npx playwright test --config test/playwright.config.ts test/e2e/offline-resilience.spec.ts
```
Expected: PASS. This spec covers the multi-op queue, retry/backoff, flap and halt paths that the re-check loop must not disturb.

- [ ] **Step 8: Commit**

```bash
git add src/admin/sync.ts test/admin/sync-drain-race.test.ts
git commit -m "fix(sync): re-check the outbox before the leader releases the lock

An entry appended between drainLoop's last emptiness check and the
Web Lock releasing got a no-op tryDrain and was stranded until the
next online transition. runEviction widened that window. The leader
now re-lists inside the lock, bounded, and stops on halted, conflict
or offline."
```

---

### Task 4: Wire `requireOwner` to owner-only routes

**Files:**
- Modify: `src/routes/admin.ts:89` (add `ownerGuard` alongside `guard`) and the `register*Routes` call sites at `:122-142` and `:362-373`
- Modify: `src/routes/admin-settings.ts`, `src/routes/admin-archive.ts`, `src/routes/integrations-gdrive.ts`, `src/routes/integrations-onedrive.ts`
- Test: `test/routes/owner-guard.test.ts` (create)

**Model:** `sonnet` — multi-file coordination and route-by-route judgment, following an established idiom.

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: each `register*Routes` opts object gains `ownerGuard: { preHandler?: typeof requireOwner }`, constructed once in `admin.ts` and threaded through the same way `guard` already is.

**Background.** The DEFERRED entry calls `requireOwner` a stub. It is not — `src/lib/auth-middleware.ts:104-112` is complete and its three tests in `test/lib/require-owner.test.ts` pass. Nothing imports it: `grep -rn requireOwner src/ test/` returns only the definition and the test. The work is wiring.

`guard` is built once at `src/routes/admin.ts:89` as `opts.requireAuth ? { preHandler: requireUser } : {}` and spread into every route as `{ ...guard }`. `ownerGuard` must respect the same `requireAuth: false` escape hatch, or the `skipGate` test path breaks.

`requireOwner` already 401s when there is no user, so it replaces `requireUser` outright rather than stacking behind it.

**Which routes.** Owner-only, in descending order of consequence:

| Route | File:line | Why |
|---|---|---|
| `GET /admin/integrations/gdrive/access-token` | `integrations-gdrive.ts:192` | hands the caller a raw OAuth access token |
| `GET /admin/integrations/onedrive/access-token` | `integrations-onedrive.ts:222` | same |
| `GET /admin/integrations/onedrive/picker-token` | `integrations-onedrive.ts:238` | same |
| `GET /admin/export` | `admin-archive.ts:34` | full-site exfiltration |
| `POST /admin/import` | `admin-archive.ts:65` | can overwrite the whole site |
| `GET /admin/integrations/gdrive/connect` | `integrations-gdrive.ts:72` | binds account-level credentials |
| `GET /admin/integrations/onedrive/connect` | `integrations-onedrive.ts:99` | same |
| `POST /admin/integrations/gdrive/disconnect` | `integrations-gdrive.ts:202` | destructive on a shared credential |
| `POST /admin/integrations/onedrive/disconnect` | `integrations-onedrive.ts:286` | same |
| `POST /admin/settings/gdrive/disconnect` | `admin-settings.ts:98` | same |
| `POST /admin/settings/onedrive/disconnect` | `admin-settings.ts:90` | same |
| `POST /admin/settings` | `admin-settings.ts:106` | site title/tagline/theme/ingest/notify config |
| `POST /admin/settings/site` | `admin-settings.ts:225` | config |
| `POST /admin/settings/banner` | `admin-settings.ts:278` | config |
| `GET /admin/settings` | `admin-settings.ts:54` | leaks integration and connect state |

Leave as `requireUser`: all post CRUD, upload, video, comments, tags, preview, sidecar, import-url, the gdrive/onedrive *import* and *status* and *fetch* routes, and the editor shell. An editor who cannot save posts is not an editor.

`POST /admin/reindex` (`admin-settings.ts:218`) and `POST /admin/posts/:slug/delete` (`admin-posts.ts:63`) are judgment calls; leave both on `requireUser` and note them in the commit body.

`POST /admin/reset` (`admin.ts:387`) already has an ad-hoc guard at `:388` keying on `request.user.id !== 0`, the magic bearer id. Leave the ad-hoc check in place and add `ownerGuard` in front of it. Do not replace the id check with a role check in this task — it is deliberately bearer-only and narrower than owner.

- [ ] **Step 1: Write the failing tests**

Create `test/routes/owner-guard.test.ts`. Follow the `app.inject` idiom from `test/routes/auth.test.ts` and the user-injection hook from `test/lib/require-owner.test.ts`, but register the hook *before* the routes:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setup } from './helpers.ts';

const OWNER_ONLY = [
  { method: 'GET' as const, url: '/admin/export' },
  { method: 'GET' as const, url: '/admin/settings' },
  { method: 'POST' as const, url: '/admin/settings/site' }
];

const EDITOR_OK = [
  { method: 'GET' as const, url: '/admin/api/tags' },
  { method: 'GET' as const, url: '/admin/editor' }
];

test('owner-only routes reject an editor with 403', async (t) => {
  const { app } = await setup(t, { role: 'editor' });
  for (const route of OWNER_ONLY) {
    const res = await app.inject({ method: route.method, url: route.url });
    assert.equal(res.statusCode, 403, `${route.method} ${route.url}: ${res.body}`);
    assert.match(res.body, /owner role required/);
  }
});

test('owner-only routes admit an owner', async (t) => {
  const { app } = await setup(t, { role: 'owner' });
  for (const route of OWNER_ONLY) {
    const res = await app.inject({ method: route.method, url: route.url });
    assert.notEqual(res.statusCode, 403, `${route.method} ${route.url}: ${res.body}`);
  }
});

test('editor-safe routes still admit an editor', async (t) => {
  const { app } = await setup(t, { role: 'editor' });
  for (const route of EDITOR_OK) {
    const res = await app.inject({ method: route.method, url: route.url });
    assert.notEqual(res.statusCode, 403, `${route.method} ${route.url}: ${res.body}`);
  }
});
```

There is no shared `test/routes/helpers.ts` today. Either add one exporting a `setup(t, { role })` that builds a temp site root, a migrated db, a seeded user of the given role and a session cookie — modelled on `setup(t)` at `test/routes/admin-posts.test.ts:23-32` — or inline an equivalent local helper in this file. Prefer the local helper: adding a shared module changes the knip surface.

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
npm test -- test/routes/owner-guard.test.ts
```
Expected: the first test FAILs — every owner-only route returns 200 for an editor because nothing consults `role`.

- [ ] **Step 3: Build the owner guard**

In `src/routes/admin.ts`, immediately after line 89:

```ts
  const guard = opts.requireAuth ? { preHandler: requireUser } : {};
  const ownerGuard = opts.requireAuth ? { preHandler: requireOwner } : {};
```

Extend the existing `requireUser` import to `import { requireOwner, requireUser } from '../lib/auth-middleware.ts';` (confirm the exact relative path against the current import line).

Thread `ownerGuard` through the `register*Routes(fastify, { ..., guard })` calls at `admin.ts:122-142` and `:362-373`, adding `ownerGuard` to each opts object whose module owns an owner-only route: the settings and archive registrars. Widen each registrar's opts type accordingly.

- [ ] **Step 4: Swap the spread at each owner-only route**

In each file, change `{ ...guard }` to `{ ...ownerGuard }` at exactly the lines listed in the table above and nowhere else. `integrations-gdrive.ts:68` and `integrations-onedrive.ts:95` build their own `const guard = { preHandler: requireUser };` — add a sibling `const ownerGuard = { preHandler: requireOwner };` in each and import `requireOwner`.

Note those two integration modules construct the guard unconditionally, with no `requireAuth` escape hatch. Keep that asymmetry as-is; changing it is out of scope.

- [ ] **Step 5: Run to verify it passes**

Run:
```bash
npm test -- test/routes/owner-guard.test.ts
```
Expected: PASS all three.

- [ ] **Step 6: Run the full unit suite**

Run:
```bash
npm run test:coverage
```
Expected: PASS. The bearer-token path attaches a synthetic `role: 'owner'` user (`auth-middleware.ts:28-32`), so any existing test authenticating by bearer clears `requireOwner` unchanged. A test authenticating as an editor against a now-owner-only route will fail — fix the test's seeded role, not the guard.

- [ ] **Step 7: Run the e2e suite**

Run:
```bash
npm run build:admin && npm run build:site && npm run test:e2e
```
Expected: PASS. The e2e server uses `ADMIN_TOKEN` bearer auth, which is owner.

- [ ] **Step 8: Document the boundary**

Add a short section to `docs/architecture.md` naming the two roles and the rule for placing a new route: owner for credentials, config, and whole-site import/export; editor for content. One paragraph, no table duplicating the code.

- [ ] **Step 9: Commit**

```bash
git add src/routes/ src/lib/auth-middleware.ts test/routes/owner-guard.test.ts docs/architecture.md
git commit -m "feat(auth): enforce the owner role on credential, config and archive routes

requireOwner was written and tested but never imported. Wired to the
OAuth access-token, connect/disconnect, settings and full-site
export/import routes. Post CRUD, upload and comments stay open to
editors. /admin/reindex and post delete stay on requireUser
deliberately; revisit if a second editor is ever invited."
```

---

### Task 5: Playwright smoke for the standalone image PWA

**Files:**
- Modify: `package.json` (root `build` chain gains `build:pwa`)
- Modify: `ci/e2e` (build the PWA before running Playwright)
- Modify: `test/e2e/server-runner.ts:52-77` region (register a static mount)
- Create: `test/e2e/image-pwa.spec.ts`

**Model:** `sonnet` — build wiring plus a browser spec, following two existing patterns.

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the URL prefix `/pwa/` serving `apps/image-pwa/dist`, available only when `ENABLE_TEST_ROUTES=1`.

**Background.** `apps/image-pwa` builds to `apps/image-pwa/dist` (app, ESM, code-split) and `apps/image-pwa/sw.js` (service worker, note: *not* in dist). Its `build` script is in `apps/image-pwa/package.json`; there is no `dev` script. The root `build` is `build:packages && build:admin && build:site && gen-precache.ts` — it never builds the PWA, so `ci/e2e` cannot serve it today. Headless coverage exists in `test/image-pwa/workflow.test.ts` plus three sibling files, but nothing drives a browser.

`@fastify/static` ^9.1.3 is already a dependency. `test/e2e/server-runner.ts` registers ad-hoc routes gated on `ENABLE_TEST_ROUTES`, which `playwright.config.ts:66` already sets. That file never reaches production `buildApp`, which makes it the right mount point.

- [ ] **Step 1: Add the PWA to the build chain**

In root `package.json`, add:

```json
    "build:pwa": "npm run build -w @rkr/image-pwa",
```

and extend the root `build` script to run it after `build:site`. Confirm the workspace name is `@rkr/image-pwa` by reading `apps/image-pwa/package.json` — the `typecheck` script in root `package.json` already references it that way.

- [ ] **Step 2: Build the PWA in CI**

In `ci/e2e`, add `npm run build:pwa` to the build step that already runs `build:packages`, `build:admin` and `build:site`, before `npm run test:e2e`.

- [ ] **Step 3: Mount the built app in the e2e server**

In `test/e2e/server-runner.ts`, alongside the existing `ENABLE_TEST_ROUTES` route registrations near line 52, register a static mount. `@fastify/static` can only be registered once per prefix, so use `decorateReply: false` if the server already registers it elsewhere:

```ts
  const pwaDist = path.resolve(import.meta.dirname, '../../apps/image-pwa/dist');
  await app.register(fastifyStatic, {
    root: pwaDist,
    prefix: '/pwa/',
    decorateReply: false
  });
  app.get('/pwa/', async (_req, reply) => {
    return reply.type('text/html').send(
      fs.readFileSync(path.resolve(import.meta.dirname, '../../apps/image-pwa/index.html'), 'utf8')
    );
  });
```

Read the file first: it may already import `fastifyStatic`, `path` and `fs`, and the app variable may be named differently. The service worker at `apps/image-pwa/sw.js` is outside `dist` — do not serve it. Registering it under a `/pwa/` prefix would give it the wrong scope, and the smoke test does not need it.

- [ ] **Step 4: Write the spec**

Create `test/e2e/image-pwa.spec.ts`. The workflow the DEFERRED entry names is upload → rotate → crop → download. Read `test/image-pwa/workflow.test.ts` for the operation semantics and `apps/image-pwa/src/toolbar.ts` for the actual control labels before writing selectors.

```ts
// Smoke test for the standalone image PWA served from apps/image-pwa/dist:
//   load → upload a fixture → rotate → crop → download
// The blog's own editor is covered by editor-flow.spec.ts; this only
// asserts the standalone app boots and its four core ops round-trip.

import { expect, test } from './coverage-fixtures.ts';

test('image-pwa: upload, rotate, crop and download round-trip', async ({ page }) => {
  await page.goto('/pwa/');

  await page.getByLabel(/choose|upload|image/i).setInputFiles({
    name: 'fixture.png',
    mimeType: 'image/png',
    // 2x1 red/blue PNG so a rotate is observable in the output dimensions.
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQwAFxUBFgYkxN0AAAAASUVORK5CYII=',
      'base64'
    )
  });

  await expect(page.getByRole('button', { name: /rotate/i })).toBeEnabled();
  await page.getByRole('button', { name: /rotate/i }).click();
  await page.getByRole('button', { name: /crop/i }).click();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /download|save/i }).click()
  ]);
  expect(download.suggestedFilename()).toMatch(/\.(png|jpe?g|webp)$/);
});
```

The selectors above are the likely shape, not verified against the markup. Correct them against `apps/image-pwa/index.html` and `src/toolbar.ts`, and prefer roles and labels over CSS. If a control has no accessible name, add one to the app rather than reaching for a CSS selector.

- [ ] **Step 5: Run the spec**

Run:
```bash
npm run build:pwa && npx playwright test --config test/playwright.config.ts test/e2e/image-pwa.spec.ts
```
Expected: PASS. If the page 404s, the static mount prefix or `dist` path is wrong. If the module fails to load, the code-split chunks are being requested from the wrong base — check that `index.html` references `./` relative paths and not `/`.

- [ ] **Step 6: Typecheck the spec**

Run:
```bash
npm run type-check
```
Expected: clean. The hyphenated script is the one that includes `tsconfig.e2e.json`.

- [ ] **Step 7: Commit**

```bash
git add package.json ci/e2e test/e2e/server-runner.ts test/e2e/image-pwa.spec.ts
git commit -m "test(image-pwa): browser smoke for the standalone editor

The PWA had headless workflow coverage but nothing drove a browser,
because the e2e webServer served the blog and never built the app.
Adds build:pwa to the build chain and a /pwa/ static mount gated on
ENABLE_TEST_ROUTES."
```

---

### Task 6: Cover the preview render's default-options path

**Files:**
- Test: `test/admin/preview-page.test.ts` (create, or extend if present)

**Model:** `sonnet` — test design against an existing injection seam, no production change expected.

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing.

**Background.** `src/admin/preview-page.ts` sits at 82.52% (`coverage-union-baseline.json:51`). `renderPreviewDocument()` at line 49 calls `buildImageMapFromOpfs(parsed.ast)` at **line 57 with no opts**, so it takes the real `createImageBitmap`/`createObjectURL` path — the exact branch the existing tests never exercise, because `test/admin/image-map-opfs.test.ts` always injects `decode` and `toUrl` through `OpfsMapOpts` (`src/admin/image-map-opfs.ts:21-24`).

The uncovered remainder is the default-options path plus `previewInputFor()` at line 82 and the entry points at lines 104, 111 and 122.

This is also where the "blob: URLs are never revoked" DEFERRED note lives. Do not add revocation. Every URL must outlive the rendered document and the preview renders once per page load. Covering the path is the deliverable; the note stays.

- [ ] **Step 1: Write the tests**

Create `test/admin/preview-page.test.ts` following the `test/admin/image-map-opfs.test.ts` idiom exactly — `installMockOpfs()` at module level, `beforeEach(() => resetMockOpfs())`, dynamic `await import()` inside each test body so the module loads after globals are patched.

The mock must supply `createImageBitmap` and `URL.createObjectURL` so the default path is real from the module's point of view. Read `test/admin/opfs-mock.ts` to see which of these it already stubs; add only what is missing, in the test file rather than in the shared mock, so no other suite's behavior shifts.

```ts
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { installMockOpfs } from './opfs-mock.ts';

const { resetMockOpfs } = installMockOpfs();

beforeEach(() => {
  resetMockOpfs();
  globalThis.createImageBitmap = (async () => ({
    width: 640,
    height: 480,
    close() {}
  })) as unknown as typeof createImageBitmap;
  globalThis.URL.createObjectURL = () => 'blob:preview';
});

test('renderPreviewDocument: default opts resolve figures through the real decode path', async () => {
  const { renderPreviewDocument } = await import('../../src/admin/preview-page.ts');
  // seed a sidecar + original blob the same way image-map-opfs.test.ts does
  const html = await renderPreviewDocument(/* draft input */);
  assert.match(html, /blob:preview/);
});

test('previewInputFor: builds an input from a stored draft', async () => {
  const { previewInputFor } = await import('../../src/admin/preview-page.ts');
  const input = await previewInputFor(/* slug */);
  assert.ok(input);
});
```

The two call signatures are left for the implementer to read off `src/admin/preview-page.ts:49` and `:82` — do not guess them. Seed the sidecar and blob with the same helpers `test/admin/image-map-opfs.test.ts` uses (`seedSidecar`, `seedBlob`); lift them into the new file rather than exporting them, to keep the existing test file's surface unchanged.

- [ ] **Step 2: Run the tests**

Run:
```bash
npm test -- test/admin/preview-page.test.ts
```
Expected: PASS.

- [ ] **Step 3: Confirm the coverage moved**

Run:
```bash
npm run coverage:ungated
```
`src/admin/**` is in the ungated pass, so this is where the number changes. Read `coverage/ungated/lcov.info` (or run `npm run test:coverage:report` for the text table) and confirm `src/admin/preview-page.ts` is above its 82.52 baseline. If it did not move, the test is exercising an injected path rather than the default one — check that no `opts` argument is being threaded in.

- [ ] **Step 4: Commit**

```bash
git add test/admin/preview-page.test.ts
git commit -m "test(preview): cover the default-opts image map path

renderPreviewDocument calls buildImageMapFromOpfs with no opts, so the
real decode and object-URL branch had no coverage — every existing
test injects both."
```

---

### Task 7: Prune DEFERRED, reseed the coverage baseline, run the gate

**Files:**
- Modify: `docs/DEFERRED.md`
- Modify: `coverage-union-baseline.json`

**Model:** `sonnet` — mechanical, but the reseed is consequential enough to want judgment about `--reseed` versus `--seed`.

**Interfaces:**
- Consumes: every prior task must be committed before this runs.
- Produces: nothing.

- [ ] **Step 1: Delete the shipped items from DEFERRED.md**

Remove these lines, which Tasks 1–6 close:

- `docs/DEFERRED.md:13` — roles stored but never enforced (Task 4). If `/admin/reindex` and post-delete were left on `requireUser`, replace the entry with a one-line note saying so rather than deleting outright.
- `docs/DEFERRED.md:22` — `_binary` / `0x` hex literals (Task 1)
- `docs/DEFERRED.md:40` — future-dated mtime wedge (Task 2)
- `docs/DEFERRED.md:41` — queued outbox entry stranded (Task 3)
- `docs/DEFERRED.md:63` — PWA e2e smoke not in CI (Task 5)

Leave in place, unchanged: `docs/DEFERRED.md:45` (blob URLs never revoked — covered but deliberately unfixed), `:67-68` (OAuth callback e2e — blocked on stub infrastructure), `:69-71` (WebGL modal — blocked on headless WebGL), and every trigger-gated feature entry.

- [ ] **Step 2: Correct the stale hook reference in CLAUDE.md**

`CLAUDE.md` says the gate is `.githooks/pre-commit`. That path does not exist. Replace that bullet with a line pointing at `lefthook.yml` and `lefthook-rc.sh`, noting that all hook logic lives in org-hooks (`profiles/sci-tiered.yml`) and that the repo carries no local pre-commit block by design.

- [ ] **Step 3: Produce a full coverage run**

Run:
```bash
npm run test:coverage && npm run build:packages && npm run build:admin && \
  npm run build:site && npm run build:pwa && npm run test:e2e
```
Expected: all green.

- [ ] **Step 4: Merge and reseed**

Run, exactly as documented at `docs/TESTING.md:260-278`:

```bash
node "$ORG_HOOKS/scripts/coverage-union-merge.mjs" \
  --unit coverage/lcov.info --e2e coverage/e2e/lcov.info \
  --out coverage/union/lcov.info --src-root src
node "$ORG_HOOKS/scripts/coverage-ratchet.mjs" --reseed \
  --lcov coverage/union/lcov.info --baseline coverage-union-baseline.json
```

Use `--reseed` (per-file max, can never lower a mark). Do **not** use `--seed`. The line universe changed only for the two new source files from Task 2 (`src/routes/post-base.ts`) and nothing was added to `coverage:ungated`, so a hard reset is not warranted and would silently drop existing marks.

- [ ] **Step 5: Review the baseline diff**

Run:
```bash
git diff coverage-union-baseline.json
```
Every changed entry should go up or hold. A mark that went *down* means `--reseed` was not what ran, or a file was renamed — investigate before committing. `src/routes/post-base.ts` should appear as a new entry near 100.

- [ ] **Step 6: Run the whole gate**

Run:
```bash
npm run check && npm run knip:gate && npm run circular && npm run type-check
```
Expected: all clean. `knip` is the likely failure here — `evaluatePostBase` and `postUpdatedAt` must both be imported by `admin.ts`, or the unused one is flagged.

- [ ] **Step 7: Commit**

```bash
git add docs/DEFERRED.md CLAUDE.md coverage-union-baseline.json
git commit -m "docs: prune the deferred items this branch closed

Reseeds the union baseline for the new route module and the preview
and image-pwa coverage. Corrects the stale .githooks/pre-commit
reference — the gate is lefthook plus org-hooks."
```

---

## Self-Review

**Spec coverage.** Seven of the sixteen DEFERRED entries are addressed: roles (4), WP binary literals (1), mtime wedge (2), outbox strand (3), PWA smoke (5), preview/blob-URL path (6), plus the baseline and doc sweep (7). Three coverage-adjacent entries are explicitly retained with reasons in the Scope section. The remaining trigger-gated entries were excluded by the scope decision recorded above.

**Behavior changes a reviewer should look for.** Task 2 changes a conflict from an inequality to an equality, which makes a baseline *newer* than mtime a 409 where it previously passed. This is intended and is asserted by a new test. Task 4 turns 15 routes from 200 to 403 for an editor; no editor exists in production today, and the bearer path is owner.

**Known soft spots.** Task 5's selectors and Task 6's two call signatures are written against files the investigation did not quote line-for-line; both steps say so and instruct the implementer to read the source first rather than trust the sketch. Task 3's test payload shape must be matched against `src/admin/drainers.ts` before it will run.

**Cross-task consistency.** `postUpdatedAt` is defined once in Task 2 Step 3 and used in Task 2 Step 4; `ownerGuard` is named identically in Task 4 Steps 3 and 4; `build:pwa` is introduced in Task 5 Step 1 and reused in Task 7 Step 3.
