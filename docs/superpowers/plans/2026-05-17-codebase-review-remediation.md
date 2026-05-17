# Codebase Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every Must-fix, Should-fix, and Consider-tier finding from the 2026-05-17 five-domain code review of rkr-blog, preferring built-in Fastify features and the already-present `@fastify/rate-limit` dependency.

**Architecture:** Surgical, well-scoped fixes grouped into phases (security/DoS → local data-loss → architecture seams → hardening → consider-tier). Each fix is independently committable and TDD-driven where the touched module is unit-testable. Server-side outbox idempotency is layered: a cheap byte-identical-write no-op plus a SQLite `applied_outbox` dedup table for non-idempotent ops. OPFS writes become atomic via temp-write + `FileSystemFileHandle.move()` with a copy fallback, plus corrupt-JSON quarantine and a guarded `_root.json` reset.

**Tech Stack:** TypeScript (ES modules, `node --test`, `--experimental-strip-types`), Fastify 5, `@fastify/rate-limit@^10` (already a dependency), `node:sqlite` via `src/lib/db.ts`, OPFS (browser), sharp/libvips.

**Conventions (from `docs/developer-quickstart.md §4` + `CLAUDE.md`):** ES modules, kebab-case filenames, no top-level side effects in `src/lib`, 500-line cap on `src/` production source (tests exempt), let bugs propagate (no broad `catch {}`), wrap external I/O in try/catch at function boundaries. Pre-commit hook runs biome / tsc / duplicate-types / no-reexports / knip:gate / circular / size / c8 coverage — do not `--no-verify`. Deferred work goes in `docs/DEFERRED.md`.

**Test command:** `npm test` (all) or `node --test --no-warnings=ExperimentalWarning --experimental-strip-types 'test/<path>.test.ts'` (single file). Coverage gate: `npm run test:coverage`.

**Conventions for this plan:** Every task ends with a commit using the repo's `type(scope): subject` style and the trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. Run the full `npm test` before each commit (the pre-commit hook will run the gauntlet anyway).

---

## Phase 0: Setup

### Task 0: Branch + baseline

**Files:** none (git only)

- [ ] **Step 1: Create the working branch**

```bash
cd /home/john/src/rkr-blog
git checkout -b fix/review-remediation-2026-05-17
```

- [ ] **Step 2: Confirm baseline green**

Run: `npm test`
Expected: all suites pass (record the count; later tasks add to it).

- [ ] **Step 3: Confirm `@fastify/rate-limit` resolves**

Run: `node -e "import('@fastify/rate-limit').then(m=>console.log(typeof m.default))"`
Expected: prints `function`. (It is already in `package.json` dependencies at `^10`; no install needed.)

---

## Phase 1: Must-fix — Security / DoS

### Task 1: Bound perspective output area (Must-fix #1a)

**Problem:** `validateOps` caps each perspective corner coord but never the resulting output rectangle. A stored op with far-apart corners makes `resamplePerspective` allocate `outW*outH*4` bytes → OOM / `RangeError`, triggerable unauthenticated via `/img/`.

**Files:**
- Modify: `src/lib/ops-validation.ts` (perspective branch, lines 143-184)
- Modify: `src/lib/perspective-resample.ts` (defensive guard after line 40)
- Test: `test/lib/ops-validation.test.ts`, `test/lib/perspective-resample.test.ts` (create if absent — check `test/lib/` first)

- [ ] **Step 1: Write the failing test (validation rejects oversized output)**

Add to `test/lib/ops-validation.test.ts` (follow the existing `node:test` + `node:assert/strict` style already in that directory):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOps } from '../../src/lib/ops-validation.ts';

test('perspective op whose output area exceeds the pixel limit is rejected', () => {
  // ~100k x 100k average edges => 1e10 px, far over SHARP_PIXEL_LIMIT (5e7)
  const corners = [
    [0, 0],
    [99999, 0],
    [99999, 99999],
    [0, 99999]
  ];
  const r = validateOps([{ type: 'perspective', corners }], { width: 100000, height: 100000 });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /perspective output .* exceeds/);
});

test('perspective op with a sane output area still validates', () => {
  const corners = [
    [0, 0],
    [800, 10],
    [790, 600],
    [5, 590]
  ];
  const r = validateOps([{ type: 'perspective', corners }], { width: 1000, height: 1000 });
  assert.equal(r.ok, true);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types 'test/lib/ops-validation.test.ts'`
Expected: the "exceeds" test FAILS (op currently accepted).

- [ ] **Step 3: Implement the area bound in `validateOps`**

In `src/lib/ops-validation.ts`:

Add the import at the top with the other imports:

```ts
import { perspectiveOutputSize } from './canvas-math.ts';
import { SHARP_PIXEL_LIMIT } from './image-constants.ts';
```

Replace the final push in the perspective branch (currently `out.push({ type: 'perspective', corners: normCorners });` at line 184) with:

```ts
      const { w: outW, h: outH } = perspectiveOutputSize(
        normCorners as unknown as readonly [
          [number, number],
          [number, number],
          [number, number],
          [number, number]
        ]
      );
      if (outW * outH > SHARP_PIXEL_LIMIT) {
        return {
          ok: false,
          error: `ops[${i}] perspective output ${outW}x${outH} exceeds ${SHARP_PIXEL_LIMIT}px limit`
        };
      }
      out.push({ type: 'perspective', corners: normCorners });
```

- [ ] **Step 4: Add the defensive guard in `resamplePerspective`**

In `src/lib/perspective-resample.ts`, add the import:

```ts
import { SHARP_PIXEL_LIMIT } from './image-constants.ts';
```

Immediately after `const { w: outW, h: outH } = perspectiveOutputSize(corners);` (line 40), add:

```ts
  // Defense in depth: a sidecar written before the validateOps area
  // check (or by a future code path) must never make us allocate an
  // unbounded RGBA buffer. Bail to "no bake" rather than OOM.
  if (outW * outH > SHARP_PIXEL_LIMIT) return null;
```

- [ ] **Step 5: Add the resample guard test**

Add to `test/lib/perspective-resample.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resamplePerspective } from '../../src/lib/perspective-resample.ts';

test('resamplePerspective returns null when output area exceeds the limit', () => {
  const src = Buffer.alloc(4); // 1x1 RGBA; never sampled — bail is before the loop
  const r = resamplePerspective(src, 1, 1, {
    corners: [
      [0, 0],
      [99999, 0],
      [99999, 99999],
      [0, 99999]
    ]
  });
  assert.equal(r, null);
});
```

- [ ] **Step 6: Run both test files; expect PASS**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types 'test/lib/ops-validation.test.ts' 'test/lib/perspective-resample.test.ts'`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ops-validation.ts src/lib/perspective-resample.ts test/lib/ops-validation.test.ts test/lib/perspective-resample.test.ts
git commit -m "fix(image): bound perspective output area against SHARP_PIXEL_LIMIT

Reject ops whose averaged-edge output rectangle exceeds 50 Mpx in
validateOps, plus a defensive null-return in resamplePerspective so a
sidecar written before this check can never OOM the server.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2: Pixel-limit the perspective bake sharp pipeline (Must-fix #1b)

**Problem:** `applyOpsWithPerspective` constructs `sharp()` twice without `limitInputPixels`; a passthrough/WP-imported large original is decoded uncapped.

**Files:**
- Modify: `src/lib/widget-helpers.ts` (the two `sharp(...)` constructions ~lines 328 and 339 — read `src/lib/widget-helpers.ts:300-360` first to confirm exact call shape)

- [ ] **Step 1: Read the target region**

Run: `sed -n '300,360p' src/lib/widget-helpers.ts` is discouraged by tooling — instead use the Read tool on `src/lib/widget-helpers.ts` offset 300 limit 70 to see both `sharp(...)` calls and the existing import of `SHARP_PIXEL_LIMIT`/`image-constants` (it may already import from `./image-constants.ts`).

- [ ] **Step 2: Add the import if missing**

Ensure `src/lib/widget-helpers.ts` imports `SHARP_PIXEL_LIMIT`:

```ts
import { SHARP_PIXEL_LIMIT } from './image-constants.ts';
```

(If it already imports other names from `./image-constants.ts`, add `SHARP_PIXEL_LIMIT` to that import list rather than duplicating.)

- [ ] **Step 3: Pass `limitInputPixels` to both sharp constructors**

For the source-decode call, change `sharp(srcPath, { failOn: 'error' })` to:

```ts
sharp(srcPath, { failOn: 'error', limitInputPixels: SHARP_PIXEL_LIMIT })
```

For the raw re-entry call `sharp(result.buffer, { raw: { ... } })`, add the same option to its options object:

```ts
sharp(result.buffer, { raw: { /* existing width/height/channels */ }, limitInputPixels: SHARP_PIXEL_LIMIT })
```

(Match `render.ts:169` which already uses `limitInputPixels: SHARP_PIXEL_LIMIT`. Keep every other existing option intact.)

- [ ] **Step 4: Verify nothing else broke**

Run: `npm test`
Expected: all PASS (no test specifically covers this; the change is option-only and type-checked by the pre-commit `tsc`). Run `npx tsc --noEmit` if you want fast feedback before the hook.

- [ ] **Step 5: Commit**

```bash
git add src/lib/widget-helpers.ts
git commit -m "fix(image): cap perspective-bake sharp pipeline at SHARP_PIXEL_LIMIT

applyOpsWithPerspective decoded the source and re-entered raw without
limitInputPixels; a passthrough/WP-imported original could be decoded
uncapped. Matches render.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3: Global Fastify error + not-found handlers (Must-fix #5)

**Problem:** No `setErrorHandler`/`setNotFoundHandler`. The `/:slug` route reads+parses the post file with no try/catch after the existence check; a normal FS-vs-index race throws → default 500 **without** the public security headers.

**Files:**
- Modify: `src/server.ts` (inside `buildApp`, after routes are registered — read `src/server.ts:80-130` to find `buildApp` and where `setPublicSecurityHeaders` is defined/exported)
- Modify: `src/routes/public.ts` (confirm `setPublicSecurityHeaders` is exported or extract a shared helper)
- Test: `test/routes/public-pages.test.ts` (existing) and/or `test/server.test.ts`

- [ ] **Step 1: Locate the security-header helper**

Use Read on `src/routes/public.ts:1-30` and search for `setPublicSecurityHeaders`. It currently sets CSP / `X-Content-Type-Options` etc. Export it if not already exported (add `export` to the function declaration). If it is defined inline per-route, extract it to `src/lib/security-headers.ts` as `export function setPublicSecurityHeaders(reply: FastifyReply): void` and re-import it in `public.ts` (this also removes duplicated header logic — DRY).

- [ ] **Step 2: Write the failing test**

Add to `test/routes/public-pages.test.ts` (follow the existing app-construction helper in that file — it builds an app via `buildApp` with injected branding):

```ts
test('a slug whose backing file is missing returns a sanitized 500 with security headers', async () => {
  const app = await buildTestApp(); // existing helper in this file
  // Insert an index row pointing at a slug with no content file on disk.
  // Use the same DB/injection seam the other tests in this file use to
  // seed posts, but skip writing the .md file (or delete it after seed).
  const res = await app.inject({ method: 'GET', url: '/definitely-missing-file-slug' });
  assert.equal(res.statusCode === 404 || res.statusCode === 500, true);
  // The contract under test: security headers present even on the error.
  assert.ok(res.headers['content-security-policy']);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.doesNotMatch(res.body, /at .*\(.*:\d+:\d+\)/); // no raw stack trace
  await app.close();
});
```

> If seeding an index row without a file is awkward with the existing helpers, instead assert the handlers exist by hitting a guaranteed-unknown route (`GET /__no_such_route__`) and checking the 404 carries the security headers + sanitized body. Keep whichever form compiles against the file's existing helpers.

- [ ] **Step 3: Run it; expect FAIL**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types 'test/routes/public-pages.test.ts'`
Expected: FAIL (missing CSP header on the error response / stack leaked).

- [ ] **Step 4: Register the handlers in `buildApp`**

In `src/server.ts`, after all `app.register(...)` route registrations and before `return app`, add:

```ts
import { setPublicSecurityHeaders } from './lib/security-headers.ts'; // or from './routes/public.ts' if exported there

app.setNotFoundHandler((request, reply) => {
  setPublicSecurityHeaders(reply);
  reply.code(404).type('text/html').send(renderNotFound()); // reuse src/templates/not-found.ts
});

app.setErrorHandler((err, request, reply) => {
  request.log.error({ err }, 'unhandled route error');
  setPublicSecurityHeaders(reply);
  const status = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
    ? err.statusCode
    : 500;
  reply
    .code(status)
    .type('text/html')
    .send(renderNotFound({ title: 'Something went wrong', status })); // sanitized; no err.message/stack to client
});
```

Import `renderNotFound` from `src/templates/not-found.ts` (read that file first; adapt the call to its actual signature — if it takes no args, send a static sanitized body string for the 5xx case instead).

- [ ] **Step 5: Remove the now-redundant `/:slug` symptom risk**

Confirm the global handler covers `src/routes/public.ts` `/:slug` (the `fs.promises.readFile`+`parsePost` at ~441). Do **not** add a local try/catch there — the global handler is the single chokepoint (DRY). Leave `/about`'s existing local handling as-is (it returns a meaningful 404; harmless).

- [ ] **Step 6: Run the test; expect PASS, then full suite**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types 'test/routes/public-pages.test.ts'` then `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/lib/security-headers.ts src/routes/public.ts test/routes/public-pages.test.ts
git commit -m "fix(server): add global error + not-found handlers with security headers

A missing/corrupt post file (normal FS-vs-index race) threw past the
default Fastify handler, returning an unsanitized 500 without CSP/nosniff.
Single chokepoint applies public security headers + a sanitized body.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 4: Rate-limit bearer-auth failures, OAuth callback, and admin (Must-fix tier — security #1/#2; Should-fix throttling)

**Problem:** The bearer-token path is CSRF-exempt *and* unthrottled (`ADMIN_TOKEN` brute-forceable); `/admin/auth/google/callback` is unauthenticated and unrate-limited.

**Files:**
- Modify: `src/server.ts` (register `@fastify/rate-limit` globally with `global: false`)
- Modify: `src/routes/auth.ts` (read `src/routes/auth.ts` fully first — note existing `config.rateLimit` usage on `/admin/auth/google/start` at ~116, and the in-process `loginFailures` map at ~259 and `pendingFlows` at ~85)
- Modify: `src/lib/auth-middleware.ts` (bearer validation path ~55-66)
- Test: `test/routes/auth.test.ts` (or the existing auth test file — locate via `ls test/routes | grep auth`)

- [ ] **Step 1: Register the plugin (opt-in mode)**

In `src/server.ts` `buildApp`, before route registration:

```ts
import rateLimit from '@fastify/rate-limit';

await app.register(rateLimit, {
  global: false, // opt routes in explicitly via { config: { rateLimit: {...} } }
  // In-memory store is correct for the documented single-instance deployment.
});
```

(Fastify 5 + `@fastify/rate-limit@10` support `global: false` so existing routes are unaffected; only routes that set `config.rateLimit` are limited.)

- [ ] **Step 2: Rate-limit the OAuth callback**

In `src/routes/auth.ts`, find the `/admin/auth/google/callback` route registration. Mirror the `config` shape already used on `/admin/auth/google/start` (it sets a `rateLimit`-ish config — match it exactly). Add to the callback route options:

```ts
{ config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }
```

- [ ] **Step 3: Write the failing test for bearer brute-force throttling**

Add to the auth test file (use the existing app-injection helper there):

```ts
test('repeated bad bearer tokens get rate-limited (429) before unlimited brute force', async () => {
  const app = await buildTestApp({ adminToken: 'correct-horse-battery-staple-very-long' });
  let saw429 = false;
  for (let i = 0; i < 40; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/reindex',
      headers: { authorization: `Bearer wrong-${i}` }
    });
    if (res.statusCode === 429) { saw429 = true; break; }
  }
  assert.equal(saw429, true);
  await app.close();
});
```

- [ ] **Step 4: Run it; expect FAIL**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types 'test/routes/auth.test.ts'`
Expected: FAIL (no 429 ever returned).

- [ ] **Step 5: Throttle the bearer path**

Two-part fix in `src/lib/auth-middleware.ts`:

(a) Apply a route-level rate limit to all `/admin/*` mutating routes by adding a shared limited config. The cleanest single chokepoint: in `src/server.ts` after registering `rate-limit`, add an `onRequest` hook scoped to admin paths, OR set `config.rateLimit` on the admin route plugin registration. Prefer the latter — in the admin route registration (`app.register(adminRoutes, ...)` in `server.ts`), Fastify lets you attach `config` per-route, not per-plugin, so instead add a global-ish limiter keyed to the bearer path inside `requireUser`/the auth preHandler:

In `auth-middleware.ts`, after a bearer token *fails* validation and before returning 401, increment the existing per-IP `loginFailures` tally (export a helper from `auth.ts` or move the tally to a shared module — see Task 12 which relocates `SESSION_COOKIE_NAME`; put the failure tally in the same new `src/lib/session-constants.ts` or a new `src/lib/login-throttle.ts`). When the tally for the request IP exceeds the existing ceiling, return 429 instead of 401, mirroring the browser `/admin/auth/token-login` ceiling logic already in `auth.ts:261-300`.

Concretely, create `src/lib/login-throttle.ts`:

```ts
// Per-IP failed-credential tally shared by the browser token-login
// route and the bearer-token middleware. In-memory: correct for the
// documented single-instance deployment (see docs/DEFERRED.md if that
// ever changes).
const FAILS = new Map<string, { n: number; first: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const CEILING = 10;

export function recordFailure(ip: string): void {
  const now = Date.now();
  const e = FAILS.get(ip);
  if (!e || now - e.first > WINDOW_MS) FAILS.set(ip, { n: 1, first: now });
  else e.n += 1;
}
export function isThrottled(ip: string): boolean {
  const e = FAILS.get(ip);
  if (!e) return false;
  if (Date.now() - e.first > WINDOW_MS) { FAILS.delete(ip); return false; }
  return e.n >= CEILING;
}
export function clearFailures(ip: string): void {
  FAILS.delete(ip);
}
/** Test-only reset. */
export function _resetLoginThrottle(): void {
  FAILS.clear();
}
```

In `auth-middleware.ts` bearer path: before validating, `if (isThrottled(ip)) return reply.code(429).send(...)`; on `adminTokenMatchesEnv` false, `recordFailure(ip)` then 401; on success, `clearFailures(ip)`. Use `request.ip` for the IP. Refactor `auth.ts:261-300`'s inline `loginFailures` map to call the same module (delete the local map; reuse `recordFailure`/`isThrottled`/`clearFailures`) so there is one tally, not two.

- [ ] **Step 6: Run the test; expect PASS; then full suite**

Run the auth test file, then `npm test`.
Expected: PASS. Add a unit test `test/lib/login-throttle.test.ts` covering window expiry + ceiling + clear (pure module, easy to cover for the coverage gate).

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/routes/auth.ts src/lib/auth-middleware.ts src/lib/login-throttle.ts test/routes/auth.test.ts test/lib/login-throttle.test.ts
git commit -m "fix(auth): throttle bearer-token failures and rate-limit OAuth callback

Single shared per-IP failed-credential tally now covers the bearer path
(previously CSRF-exempt and unthrottled, making ADMIN_TOKEN brute-forceable)
and the browser token-login route. Register @fastify/rate-limit (opt-in)
and apply it to the unauthenticated /admin/auth/google/callback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2: Must-fix — Local data-loss

### Task 5: Atomic OPFS writes + corrupt-JSON quarantine (Must-fix #3a)

**Problem:** `writeJson`/`writeBlob` truncate-then-stream; a crash mid-write loses a draft, wedges the outbox on a throwing `JSON.parse`, or truncates `_root.json`.

**Files:**
- Modify: `src/admin/opfs.ts` (`writeJson`, `writeBlob`, `readJson`)
- Test: follow the existing OPFS test pattern — check `test/admin/` for an existing `opfs` test and its OPFS mock/harness; reuse it. If none exists, the executor must add a minimal OPFS fake (Map-backed `FileSystemDirectoryHandle`/`FileSystemFileHandle` with `createWritable`, `move`, `getFile`).

- [ ] **Step 1: Inspect existing OPFS test harness**

Run: `ls test/admin` and read any `*opfs*` or `*outbox*` test to learn how OPFS is faked in this repo. Match that harness; do not invent a parallel one.

- [ ] **Step 2: Write failing tests**

In the OPFS test file add:

```ts
test('writeJson is atomic: a crash between truncate and close never yields a partial file', async () => {
  await writeJson('meta/_root.json', { schemaVersion: 1, deviceId: 'a', nextSeq: 3 });
  // Simulate an interrupted second write by injecting a writable that
  // throws on write() (use the harness fault hook). The original
  // content must survive intact.
  await assert.rejects(() => writeJsonWithFaultyWrite('meta/_root.json', { schemaVersion: 1, deviceId: 'a', nextSeq: 4 }));
  const after = await readJson('meta/_root.json');
  assert.deepEqual(after, { schemaVersion: 1, deviceId: 'a', nextSeq: 3 });
});

test('readJson quarantines a corrupt file instead of throwing', async () => {
  await writeRawFile('outbox/7.savePost.json', '{ this is not json');
  const v = await readJson('outbox/7.savePost.json');
  assert.equal(v, null); // treated as absent, not a thrown SyntaxError
  // and the corrupt file is moved aside so list() no longer trips on it
  const names = await listDir('outbox');
  assert.equal(names.includes('7.savePost.json'), false);
});
```

(`writeJsonWithFaultyWrite`, `writeRawFile` are harness helpers — add them to the test harness using the same fault-injection seam the existing tests use.)

- [ ] **Step 3: Run; expect FAIL**

Run the OPFS test file. Expected: both FAIL (current writeJson truncates; readJson throws on bad JSON).

- [ ] **Step 4: Implement atomic write + quarantine**

Replace `writeJson` body (keep the signature + the `isSupported` guard + the doc comment, extend it):

```ts
export async function writeJson(path: string, value: unknown): Promise<void> {
  /* v8 ignore next 3 -- defensive guard; isSupported() gates upstream */
  if (!isSupported()) {
    throw new Error('writeJson called on unsupported browser');
  }
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}
```

Replace `writeBlob` body similarly:

```ts
export async function writeBlob(path: string, blob: Blob): Promise<void> {
  /* v8 ignore next 3 -- defensive guard; isSupported() gates upstream */
  if (!isSupported()) {
    throw new Error('writeBlob called on unsupported browser');
  }
  await atomicWrite(path, blob);
}
```

Add the shared helper:

```ts
/** Write to a sibling temp file then atomically swap it into place.
 * OPFS exposes FileSystemFileHandle.move() in the browsers we support;
 * a crash before the move leaves only the orphan temp (cleaned on next
 * write of the same leaf), never a truncated target. Copy fallback for
 * engines without move(). */
async function atomicWrite(path: string, data: string | Blob): Promise<void> {
  const { parent, leafName } = await walk(path, true);
  const tmpName = `.${leafName}.tmp-${crypto.randomUUID()}`;
  const tmp = await parent.getFileHandle(tmpName, { create: true });
  try {
    const w = await tmp.createWritable();
    await w.write(data);
    await w.close();
  } catch (e) {
    await parent.removeEntry(tmpName).catch(() => {});
    throw e;
  }
  const moveable = tmp as FileSystemFileHandle & {
    move?: (dir: FileSystemDirectoryHandle, name: string) => Promise<void>;
  };
  if (typeof moveable.move === 'function') {
    await moveable.move(parent, leafName);
    return;
  }
  // Fallback: copy temp → target, then drop temp. Target may briefly
  // be partial here, but only on engines lacking move() (rare).
  const target = await parent.getFileHandle(leafName, { create: true });
  const tw = await target.createWritable();
  await tw.write(await (await tmp.getFile()));
  await tw.close();
  await parent.removeEntry(tmpName).catch(() => {});
}
```

Update `readJson`: wrap the parse and quarantine on failure. Replace the final two lines (`if (text.length === 0) return null; return JSON.parse(text) as T;`) with:

```ts
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Corrupt (e.g. truncated by a pre-atomic-write crash). Quarantine
    // so outbox.list() / readRoot() see it as absent rather than
    // throwing and wedging the queue for every future entry.
    await parent.removeEntry(leafName).catch(() => {});
    return null;
  }
```

(Removing the bad leaf is sufficient — `list()` filters by what parses; a future write recreates it. If preserving forensics is wanted, `move` it to `quarantine/<leaf>` instead; the queue-unwedge requirement only needs it gone from its directory.)

- [ ] **Step 5: Run tests; expect PASS; then full suite**

Run the OPFS test file then `npm test`.

- [ ] **Step 6: Commit**

```bash
git add src/admin/opfs.ts test/admin/
git commit -m "fix(opfs): atomic writeJson/writeBlob + quarantine corrupt JSON

createWritable() truncates the target first; a crash mid-write lost
drafts and wedged the outbox on a throwing JSON.parse. Write to a
sibling temp then move()/copy into place, and treat unparseable JSON
as absent (quarantined) instead of throwing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 6: Guard `_root.json` reset (Must-fix #3b)

**Problem:** A null/partial `_root.json` makes `ensureSchema` mint a fresh `deviceId` and reset `nextSeq` to 0 — colliding with un-drained outbox entries and orphaning the active draft.

**Files:**
- Modify: `src/admin/opfs-schema.ts` (`ensureSchema`, lines 73-82)
- Test: the opfs-schema test (check `test/admin` for an existing one)

- [ ] **Step 1: Write the failing test**

```ts
test('ensureSchema refuses to reset nextSeq below the max on-disk outbox seq', async () => {
  // No root, but outbox has entries 1,2,5 queued.
  await writeRawFile('outbox/1.savePost.json', JSON.stringify({ seq: 1 }));
  await writeRawFile('outbox/2.upload.json', JSON.stringify({ seq: 2 }));
  await writeRawFile('outbox/5.savePost.json', JSON.stringify({ seq: 5 }));
  const status = await ensureSchema();
  const root = await readRoot();
  assert.ok(root);
  assert.ok((root!.nextSeq ?? 0) > 5, 'nextSeq must clear existing outbox seqs');
  assert.equal(status.status, 'fresh');
});
```

- [ ] **Step 2: Run; expect FAIL** (fresh root sets `nextSeq: 0`).

- [ ] **Step 3: Implement the guard**

In `opfs-schema.ts`, add a helper and use it in the `if (!onDisk)` branch:

```ts
import { listDir } from './opfs.ts';

async function maxOutboxSeqOnDisk(): Promise<number> {
  const names = await listDir(OPFS_DIRS.OUTBOX);
  let max = 0;
  for (const n of names) {
    const seq = Number.parseInt(n.split('.')[0] ?? '', 10);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max;
}
```

Replace the `if (!onDisk) { await writeJson(ROOT_PATH, makeRoot()); return { status: 'fresh' }; }` block with:

```ts
  if (!onDisk) {
    const root = makeRoot();
    // A corrupt/truncated root must not reset nextSeq beneath live
    // outbox entries (seq collision) — start above the highest on-disk
    // seq so coalescing/ordering stay sound.
    const floor = await maxOutboxSeqOnDisk();
    if (floor > 0) root.nextSeq = floor + 1;
    await writeJson(ROOT_PATH, root);
    return { status: 'fresh' };
  }
```

- [ ] **Step 4: Run; expect PASS; full suite**

- [ ] **Step 5: Commit**

```bash
git add src/admin/opfs-schema.ts test/admin/
git commit -m "fix(opfs): never reset nextSeq below live outbox seqs on root loss

A corrupt _root.json regenerated with nextSeq:0, colliding with
un-drained outbox entries. Seed nextSeq above the max on-disk seq.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 7: Coalesce new posts by draftId, not empty slug (Must-fix #4)

**Problem:** Two offline-created new posts both queue `savePost` with `slug:''`; `coalescePending` keeps only the highest seq → the other is deleted before drain.

**Files:**
- Modify: `src/lib/outbox-types.ts` (`coalescePending`, lines 69-97)
- Modify: `src/admin/save.ts` (`queueSavePost` — must populate `OutboxEntryBase.draftId`; read `src/admin/save.ts` first, esp. the append call ~150 and the `slug:''` comment ~77)
- Modify: `src/admin/outbox.ts` (`outboxAppend` must persist `draftId` if it currently strips it — read the append signature)
- Test: `test/lib/outbox-types.test.ts` (create/extend; pure module — must be covered for the gate)

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coalescePending, type OutboxEntry } from '../../src/lib/outbox-types.ts';

test('two new posts (empty slug) are NOT coalesced when they have distinct draftIds', () => {
  const base = { createdAt: '2026-05-17T00:00:00Z', deviceId: 'd' };
  const entries: OutboxEntry[] = [
    { ...base, seq: 1, draftId: 'draft-A', op: 'savePost', payload: { slug: '', title: 'A', markdown: 'a' } },
    { ...base, seq: 2, draftId: 'draft-B', op: 'savePost', payload: { slug: '', title: 'B', markdown: 'b' } }
  ];
  const kept = coalescePending(entries);
  assert.equal(kept.length, 2);
});

test('two saves of the same new draft DO coalesce to the latest', () => {
  const base = { createdAt: '2026-05-17T00:00:00Z', deviceId: 'd' };
  const entries: OutboxEntry[] = [
    { ...base, seq: 1, draftId: 'draft-A', op: 'savePost', payload: { slug: '', title: 'A', markdown: 'a' } },
    { ...base, seq: 3, draftId: 'draft-A', op: 'savePost', payload: { slug: '', title: 'A2', markdown: 'a2' } }
  ];
  const kept = coalescePending(entries);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.seq, 3);
});

test('existing posts still coalesce by slug', () => {
  const base = { createdAt: '2026-05-17T00:00:00Z', deviceId: 'd' };
  const entries: OutboxEntry[] = [
    { ...base, seq: 1, op: 'savePost', payload: { slug: 'hello', title: 'H', markdown: 'h' } },
    { ...base, seq: 2, op: 'savePost', payload: { slug: 'hello', title: 'H2', markdown: 'h2' } }
  ];
  assert.equal(coalescePending(entries).length, 1);
});
```

- [ ] **Step 2: Run; expect FAIL** (first test: both collapse under `''`).

- [ ] **Step 3: Implement the keyed coalescing**

In `src/lib/outbox-types.ts`, change the `savePost` keying to use `draftId` when `slug === ''`:

```ts
function savePostKey(e: Extract<OutboxEntry, { op: 'savePost' }>): string {
  // New, never-synced posts share slug '' — keying those by slug
  // collapses distinct posts into one and drops all but the latest.
  // Distinguish them by draftId. Existing posts key by their slug.
  return e.payload.slug !== '' ? `slug:${e.payload.slug}` : `draft:${e.draftId ?? `seq:${e.seq}`}`;
}
```

Replace the three `e.payload.slug` references in the savePost branches (lines 75, 77, 92) with `savePostKey(e)`. (Fallback `seq:${e.seq}` means a missing `draftId` degrades to "never coalesce" — safe: no data loss, just a redundant drain.)

- [ ] **Step 4: Populate `draftId` on the queued entry**

In `src/admin/save.ts` `queueSavePost`, pass the active draft id into the outbox append so `OutboxEntryBase.draftId` is set. Read `src/admin/save.ts` and `src/admin/outbox.ts` `outboxAppend` signature; thread the current `draftId` (available from the draft/session model — same id `startDraftPersistence`/`currentDraftId` uses) through. Confirm `outboxAppend` writes `draftId` into the entry JSON (extend it if it currently omits the optional field).

- [ ] **Step 5: Run tests; expect PASS; full suite**

Run `test/lib/outbox-types.test.ts` then `npm test`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/outbox-types.ts src/admin/save.ts src/admin/outbox.ts test/lib/outbox-types.test.ts
git commit -m "fix(outbox): coalesce new posts by draftId, not shared empty slug

Two posts created offline both queued savePost with slug:'' and
coalescePending dropped all but the highest seq, silently losing one.
Key never-synced saves by draftId.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 8: Layered server-side outbox idempotency (Must-fix #2)

**Problem:** Client stamps `x-rkr-outbox-seq` and assumes idempotency the server never implements. A lost-ACK retry hits the mtime guard with stale `lastSyncedAt` → phantom 409 that can drop a newer coalesced edit.

**Approach (user-chosen "both layered"):**
1. Cheap path: a `savePost` whose rendered file content is byte-identical to what's already on disk returns 200 (no-op) instead of 409.
2. Robust path: a `applied_outbox` SQLite table records `(device_id, seq)` with the original HTTP status + response body; a replay short-circuits to the stored result. Covers non-idempotent ops (`commitImageEdit`, anything that triggers `runReindex`/bake upload).

**Files:**
- Read first: `src/routes/admin.ts:140-310` (the `savePost` / sidecar / commitImageEdit handlers, the mtime 409 guard, where `x-rkr-outbox-seq` would arrive), `src/lib/db.ts` (Db interface + how migrations/tables are created), `src/lib/migrate.ts` and `src/cli/migrate.ts` (schema migration pattern).
- Create: `src/lib/applied-outbox.ts` (pure-ish DB helper)
- Modify: `src/routes/admin.ts` (savePost + commitImageEdit handlers)
- Modify: schema/migration (follow the existing migration registration pattern found in `src/lib/migrate.ts`)
- Test: `test/lib/applied-outbox.test.ts` (unit, in-memory Db) + an integration test in `test/routes/` exercising replay

- [ ] **Step 1: Read the schema/migration + admin handler patterns**

Read `src/lib/db.ts`, `src/lib/migrate.ts`, and `src/routes/admin.ts:140-310`. Identify: how a new table/migration is declared, the `Db` query API shape, and the exact place the savePost handler computes/compares mtime and returns 409.

- [ ] **Step 2: Add the `applied_outbox` table via the existing migration mechanism**

Following the repo's migration pattern (do not hand-roll DDL outside it), add:

```sql
CREATE TABLE IF NOT EXISTS applied_outbox (
  device_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  status     INTEGER NOT NULL,
  body       TEXT NOT NULL,
  PRIMARY KEY (device_id, seq)
);
```

Plus a pruning index/strategy: keep it bounded (e.g. delete rows older than 7 days on insert, or cap to the newest N per device). Implement bounded pruning in the helper (Step 3), not a cron.

- [ ] **Step 3: Write `src/lib/applied-outbox.ts` (TDD)**

Failing test `test/lib/applied-outbox.test.ts` (use the in-memory Db seam other lib tests use):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/lib/db.ts'; // match the real export
import { recordApplied, lookupApplied, pruneApplied } from '../../src/lib/applied-outbox.ts';

test('lookupApplied returns the stored result for a replayed (device,seq)', () => {
  const db = openDb(':memory:'); // adapt to real signature; run migrations
  assert.equal(lookupApplied(db, 'dev1', 7), null);
  recordApplied(db, 'dev1', 7, 200, '{"ok":true}');
  assert.deepEqual(lookupApplied(db, 'dev1', 7), { status: 200, body: '{"ok":true}' });
});

test('pruneApplied drops rows older than the retention window', () => {
  const db = openDb(':memory:');
  recordApplied(db, 'dev1', 1, 200, 'x', new Date(Date.now() - 30 * 864e5).toISOString());
  pruneApplied(db);
  assert.equal(lookupApplied(db, 'dev1', 1), null);
});
```

Implement `recordApplied(db, deviceId, seq, status, body, appliedAt?)`, `lookupApplied(db, deviceId, seq)`, `pruneApplied(db)` (delete `applied_at < now-7d`). Keep it a thin typed wrapper over the `Db` interface (matches the clean DB seam the architecture review praised).

- [ ] **Step 4: Wire idempotency into the admin handlers (failing integration test first)**

Integration test in `test/routes/` (reuse the admin app harness):

```ts
test('replaying a savePost (same device+seq) returns the original 2xx, not a 409', async () => {
  const app = await buildAdminTestApp();
  const headers = { authorization: 'Bearer <test-admin-token>', 'x-rkr-outbox-seq': '42', 'x-rkr-device-id': 'devX' };
  const body = { slug: '', title: 'Hello', markdown: '# hi' };
  const first = await app.inject({ method: 'POST', url: '/admin/posts', headers, payload: body });
  assert.equal(first.statusCode < 300, true);
  // Same device+seq replay (simulates a lost ACK + client retry):
  const replay = await app.inject({ method: 'POST', url: '/admin/posts', headers, payload: body });
  assert.equal(replay.statusCode, first.statusCode);
  assert.equal(replay.body, first.body);
  await app.close();
});
```

(Use whatever device-id header the client actually sends — inspect `drainers.ts`/`sync.ts` for the exact header names; the entry already carries `deviceId`, so the drain POST must send it. If the client does not currently send a device id header, add it on the client drain POST in `src/admin/drainers.ts`/`sync.ts` alongside the existing `x-rkr-outbox-seq` so the server can key the table.)

- [ ] **Step 5: Implement the handler logic**

In each mutating admin handler that a drain hits (`savePost`, `commitImageEdit`, sidecar ops):

```ts
const deviceId = request.headers['x-rkr-device-id'];
const seqRaw = request.headers['x-rkr-outbox-seq'];
const seq = typeof seqRaw === 'string' ? Number.parseInt(seqRaw, 10) : NaN;
const idempotent = typeof deviceId === 'string' && deviceId !== '' && Number.isFinite(seq);

if (idempotent) {
  const prior = lookupApplied(db, deviceId, seq);
  if (prior) {
    return reply.code(prior.status).type('application/json').send(prior.body);
  }
}

// ... existing handler work ...

// Cheap layer (savePost only): if the rendered file content is
// byte-identical to what's already on disk, treat as a satisfied
// no-op (status 200) rather than evaluating the mtime guard — this
// self-heals a lost-ACK replay even without the table.
//   compare canonical rendered markdown bytes to fs.readFile(target)

// On success, before sending the 2xx:
if (idempotent) {
  recordApplied(db, deviceId, seq, statusCode, responseBodyString);
  pruneApplied(db);
}
```

Place the byte-identical short-circuit *before* the existing mtime/`X-Rkr-Last-Synced-At` 409 comparison so a replay that matches disk never produces a phantom conflict. Keep the 409 path for genuine concurrent divergence (different content + stale `lastSyncedAt`).

- [ ] **Step 6: Run unit + integration tests; expect PASS; full suite**

- [ ] **Step 7: Commit**

```bash
git add src/lib/applied-outbox.ts src/routes/admin.ts src/admin/drainers.ts src/admin/sync.ts test/lib/applied-outbox.test.ts test/routes/ <migration files>
git commit -m "fix(outbox): server-side idempotency for drained entries

Layered: byte-identical savePost returns 200 (self-heals lost-ACK),
and an applied_outbox(device,seq) table short-circuits any replayed op
to its original 2xx instead of a phantom 409 that could drop a newer
coalesced edit. Client drain now sends x-rkr-device-id.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3: Must-fix — Architecture seam

### Task 9: Invert the `routes → cli/reindex` dependency (Must-fix #6)

**Problem:** `src/routes/*` imports `runReindex`/`readIndexedPosts*`/`readTagCounts` from `src/cli/reindex.ts` — request path transitively pulls a CLI command (wrong dependency direction).

**Files:**
- Create: `src/lib/post-index.ts`
- Modify: `src/cli/reindex.ts` (re-import from lib; keep only the CLI command wrapper)
- Modify: `src/routes/public.ts`, `src/routes/admin.ts`, `src/routes/admin-posts.ts`, `src/routes/admin-settings.ts` (import from `../lib/post-index.ts`)
- Test: existing tests must stay green; add `test/lib/post-index.test.ts` if the moved functions lack direct coverage (coverage gate excludes `src/admin/**` but not `src/lib/**`).

- [ ] **Step 1: Identify the exact moved surface**

Run: `grep -rn "from '.*cli/reindex" src/routes` and `grep -n "^export " src/cli/reindex.ts` to list every symbol routes import (`runReindex`, `readIndexedPosts`, `readIndexedPostBySlug`, `readTagCounts`, `readAllIndexedPosts`, plus types).

- [ ] **Step 2: Move the index read/write functions to `src/lib/post-index.ts`**

Cut the pure `Db`-taking functions (the reindex transform + the `readIndexed*`/`readTagCounts` queries) verbatim into `src/lib/post-index.ts`, preserving signatures, names, and JSDoc. No top-level side effects (lib rule). Keep the SQL and behavior byte-identical — this is a move, not a rewrite.

- [ ] **Step 3: Make `src/cli/reindex.ts` a thin wrapper**

`src/cli/reindex.ts` keeps only the CLI command (`reindexCmd` default export / arg parsing) and imports `runReindex` from `../lib/post-index.ts`. Re-export nothing the no-reexports gate would flag (check the gate's rule; if re-export is disallowed, update importers directly instead of re-exporting).

- [ ] **Step 4: Repoint route imports**

In `public.ts`, `admin.ts`, `admin-posts.ts`, `admin-settings.ts`: change `from '../cli/reindex.ts'` → `from '../lib/post-index.ts'`.

- [ ] **Step 5: Verify the dependency cycle gate + tests**

Run: `npm test` then the circular-deps check the pre-commit uses (find it: `grep -n "circular\|dpdm\|madge" package.json`). Expected: clean; `routes` and `cli` both depend inward on `lib`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/post-index.ts src/cli/reindex.ts src/routes/public.ts src/routes/admin.ts src/routes/admin-posts.ts src/routes/admin-settings.ts test/
git commit -m "refactor(arch): move index queries to lib/post-index; cli/reindex wraps it

Routes no longer import a CLI command; dependency arrow now points
inward (routes->lib, cli->lib). Pure move, no behavior change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4: Should-fix

### Task 10: Scope `decodeHtmlEntities` + guard out-of-range codepoints (Should-fix)

**Files:**
- Modify: `src/lib/content.ts` (`decodeHtmlEntities` ~209-217; its call site ~89-91)
- Read first: `src/lib/content.ts:80-100,205-225` and `src/lib/wp-import.ts` (move the decode to the importer)
- Test: `test/lib/content.test.ts` (or wherever `parsePost` is tested)

- [ ] **Step 1: Failing tests**

```ts
test('a frontmatter title is treated literally — markup entities are NOT decoded into live markup', () => {
  const post = parsePost(/* frontmatter */ 'title: "Hi &#60;img src=x onerror=alert(1)&#62;"\n', '...');
  assert.equal(post.title.includes('<img'), false);
});
test('a malformed numeric entity in a title does not throw', () => {
  assert.doesNotThrow(() => parsePost('title: "x &#1114112; y"\n', '...'));
});
```

(Adapt to the real `parsePost` signature.)

- [ ] **Step 2: Run; expect FAIL** (decode currently turns `&#60;` into `<`; `&#1114112;` throws `RangeError`).

- [ ] **Step 3: Implement**

Move the entity-decode into the WP import path only (`src/lib/wp-import.ts` where `title.rendered` is consumed). In `src/lib/content.ts`, stop calling `decodeHtmlEntities` on `frontmatter.title`/`subtitle` (treat frontmatter as literal). If a shared decode must remain for legacy stored content, restrict its regex to text entities and exclude markup-significant ones, and clamp numeric codepoints:

```ts
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => {
      const cp = Number.parseInt(n, 10);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const cp = Number.parseInt(n, 16);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : _;
    });
  // Deliberately does NOT decode &lt; &gt; &quot; &#39; so the in-memory
  // value can never contain markup-significant characters.
}
```

- [ ] **Step 4: Run; PASS; full suite. Step 5: Commit**

```bash
git add src/lib/content.ts src/lib/wp-import.ts test/lib/content.test.ts
git commit -m "fix(content): don't decode markup entities in titles; clamp codepoints

Scope HTML-entity decoding to the WP importer and never decode
&lt;/&gt;/&quot;/&#39;, removing a latent raw-title injection footgun;
guard String.fromCodePoint against out-of-range codepoints (was a 500).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 11: Protect savePost-referenced originals from eviction (Should-fix)

**Files:**
- Read first: `src/admin/eviction.ts:34-87`, `src/lib/eviction-pure.ts:59-73`, and how a `savePost` outbox payload exposes referenced figure ids (likely parse `payload.markdown`, or add `refIds` to the savePost entry like draft meta carries).
- Modify: `src/admin/eviction.ts` (`collectLiveRefIds`)
- Test: `test/admin/` eviction test (extend existing)

- [ ] **Step 1: Failing test** — seed a queued `savePost` referencing image id `X`, no `upload` entry, no DOM; assert `collectLiveRefIds` includes `X`.
- [ ] **Step 2: Run; FAIL.**
- [ ] **Step 3: Implement** — in `collectLiveRefIds`, union the figure ids referenced by every queued `savePost` payload. Reuse the existing figure-id extractor (`src/lib/figure-ids.ts`) over `payload.markdown` rather than re-parsing by hand.
- [ ] **Step 4: PASS; full suite. Step 5: Commit**

```bash
git add src/admin/eviction.ts test/admin/
git commit -m "fix(eviction): protect originals referenced by a queued savePost

collectLiveRefIds only guarded upload-entry + DOM ids; an unsynced
post's images could be evicted before its savePost drained.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 12: Relocate `SESSION_COOKIE_NAME` (Should-fix lib→routes back-edge)

**Files:**
- Create: `src/lib/session-constants.ts` (export `SESSION_COOKIE_NAME` and any other cross-cut auth constants currently in `routes/auth.ts` consumed by lib)
- Modify: `src/routes/auth.ts` (import + re-export-free), `src/lib/auth-middleware.ts` (import from lib)
- Test: existing auth tests stay green

- [ ] **Step 1:** Move the constant; update both importers. Verify the no-reexports gate is satisfied (don't re-export from `auth.ts` if disallowed — point all consumers at the lib module).
- [ ] **Step 2:** `npm test`; circular check clean.
- [ ] **Step 3: Commit**

```bash
git add src/lib/session-constants.ts src/routes/auth.ts src/lib/auth-middleware.ts
git commit -m "refactor(auth): move SESSION_COOKIE_NAME to lib to drop lib->routes edge

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 13: Make the search-route DB catch observable (Should-fix)

**Files:**
- Modify: `src/routes/public.ts` (search handler ~392-396)
- Test: `test/routes/public-pages.test.ts`

- [ ] **Step 1:** Read `src/routes/public.ts:370-400`. The catch currently degrades any DB error to `[]` silently.
- [ ] **Step 2: Failing test** — assert that a non-"missing FTS table" error path logs (spy on `req.log.error` via the test harness) or, simpler, narrow the catch and assert a thrown unexpected error reaches the global error handler (now installed in Task 3).
- [ ] **Step 3: Implement** — only swallow the specific "no such table: posts_fts" case (string-match on the error message *or*, better, probe once at registration with `SELECT 1 FROM posts_fts LIMIT 0` and cache a boolean). Any other error: `req.log.error({ err }, 'search query failed')` and rethrow (let the global handler render it) — per the "let bugs propagate" convention.
- [ ] **Step 4: PASS; full suite. Step 5: Commit**

```bash
git add src/routes/public.ts test/routes/public-pages.test.ts
git commit -m "fix(search): stop silently swallowing all DB errors as empty results

Only the missing-FTS-table case degrades to []; other errors are
logged and propagate to the global handler.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 14: prose-markdown caption round-trip safety + tests (Should-fix)

**Files:**
- Modify: `src/lib/prose-markdown.ts` (`quote()` ~161-166 and `emitFigure` ~224-241)
- Test: `test/lib/prose-markdown.test.ts`

- [ ] **Step 1:** Read `src/lib/prose-markdown.ts` around `quote`/`emitFigure`. `quote()` only escapes `\` and `"`; a caption with `}`, `|`, `,`, or `\n` can corrupt the `::figure{...}` directive on the editor-save round trip.
- [ ] **Step 2: Failing round-trip test** — for each of `}`, `|`, `,`, `"`, `\`, `\n` in a caption/alt, assert `markdown → ast → markdown` preserves the caption text exactly (use the project's existing prose↔markdown round-trip helper if one exists; otherwise parse with the same remark pipeline the app uses).
- [ ] **Step 3: Implement** — strip/encode newlines in captions before emit (captions are single-line in the directive grammar) and confirm remark-directive tolerates `}`/`|`/`,` inside the quoted value; if not, percent- or backslash-encode them in `quote()` and decode on parse. Keep the change minimal and symmetric (encode on emit, decode on parse).
- [ ] **Step 4: PASS; full suite. Step 5: Commit**

```bash
git add src/lib/prose-markdown.ts test/lib/prose-markdown.test.ts
git commit -m "fix(prose-markdown): make figure caption/alt round-trip directive-safe

quote() only escaped \\ and \"; captions with } | , or newlines could
split the ::figure directive on save. Encode/decode symmetrically + tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 15: Surface online-save 409 instead of a misleading "queued" toast (Should-fix)

**Files:**
- Modify: `src/admin/save.ts` (the online direct-POST `catch {}` ~140-145 and the success toast ~160-163)
- Test: `test/admin/` save test (extend)

- [ ] **Step 1:** Read `src/admin/save.ts:120-165`. The `catch {}` discards a 409 and still shows "queued for sync".
- [ ] **Step 2: Failing test** — mock the direct POST to return 409; assert the user sees a conflict indication (not a success/queued toast) and the entry is still queued (so the drain path can resolve it, now idempotent per Task 8).
- [ ] **Step 3: Implement** — inspect the caught response: distinguish a network failure (legit queue, keep the toast) from a 409 (surface conflict immediately via the existing conflict UI/badge; do not show the cheerful queued toast).
- [ ] **Step 4: PASS; full suite. Step 5: Commit**

```bash
git add src/admin/save.ts test/admin/
git commit -m "fix(save): surface a 409 on online save instead of a 'queued' toast

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 16: Admin bundle must not straddle a deploy (Should-fix SWR)

**Files:**
- Modify: `src/site/sw-core.ts` (the `/static/*` SWR rule ~157-181; the infinite cap ~181)
- Test: `test/` service-worker test if one exists (`grep -rl sw-core test`), else a focused unit test of the route-decision function

- [ ] **Step 1:** Read `src/site/sw-core.ts:80-190`. `/static/*` is SWR with `Number.POSITIVE_INFINITY` cap; the admin bundle (`/static/admin/main.js`) served stale-first can run last deploy's client against this deploy's API for a session.
- [ ] **Step 2: Failing test** — assert the cache strategy selector returns network-first (or cache-first strictly keyed on the `?v=` hash) for the admin bundle path, and that the `/static` cap is finite.
- [ ] **Step 3: Implement** — special-case the admin bundle path to network-first (fall back to cache offline); replace `Number.POSITIVE_INFINITY` with a sane finite cap (e.g. 64) for `/static`. Keep public static assets SWR.
- [ ] **Step 4: PASS; full suite. Step 5: Commit**

```bash
git add src/site/sw-core.ts test/
git commit -m "fix(sw): admin bundle network-first; bound /static cache cap

Prevents an admin session straddling a client/server protocol version
across a deploy; caps unbounded /static retention.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 17: Split oversized files under the 500-line cap (Should-fix)

**Files:** `src/routes/public.ts` (632), `src/templates/admin-styles.ts` (639), `src/admin/main.ts` (507)

- [ ] **Step 1:** Run `wc -l src/routes/public.ts src/templates/admin-styles.ts src/admin/main.ts` to confirm current counts (some may have shrunk after Task 9 moved index queries out of `public.ts`).
- [ ] **Step 2: Split `public.ts`** — extract the `/img/:filename` handler + `findVariantOutput`/`resolveInlineConcurrency`/`MIME`/`FILENAME_RE` into `src/routes/public-img.ts`, registered as a sub-plugin the same way `registerPublicCommentRoutes` is (`public.ts:86`). Behavior unchanged.
- [ ] **Step 3: Split `admin-styles.ts`** — it is a CSS string blob; split by section into 2 modules (`admin-styles-core.ts` + `admin-styles-editor.ts`) concatenated by the template, or move the CSS to a `.css` static asset served by the existing static route. Pick whichever the codebase already does for `static/themes/*` — prefer extracting to a real `.css` file under `static/` if the admin page can link it (check how the public theme CSS is loaded).
- [ ] **Step 4: Split `main.ts`** — extract the largest cohesive block (e.g. startup wiring vs. event binding) into a sibling module imported by `main.ts`. `src/admin/**` is coverage-exempt so no new coverage needed, but the size gate still applies.
- [ ] **Step 5:** `npm test` + run the size gate (`grep -n "size" package.json` to find its command) — expect all three ≤ 500.
- [ ] **Step 6: Commit** (one commit per file split is fine; or one commit if small):

```bash
git add src/routes/public.ts src/routes/public-img.ts src/templates/admin-styles*.ts src/admin/main.ts src/admin/<extracted>.ts
git commit -m "refactor: split public.ts/admin-styles.ts/main.ts under the 500-line cap

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5: Consider-tier

### Task 18: Stop logging raw OAuth error objects (Consider)

**Files:** `src/routes/auth.ts` (~162,171), `src/routes/integrations-gdrive.ts` (~125), `src/routes/integrations-onedrive.ts` (~155,255)

- [ ] **Step 1:** Read each `req.log.warn({ err }, ...)` / `error({ err })` on the OAuth/token-exchange paths.
- [ ] **Step 2:** Replace `{ err }` with a sanitized shape: `{ err: { name: err?.name, message: err?.message, code: (err as any)?.code } }`. Never serialize the full error/response on these paths.
- [ ] **Step 3:** `npm test`. **Step 4: Commit**

```bash
git add src/routes/auth.ts src/routes/integrations-gdrive.ts src/routes/integrations-onedrive.ts
git commit -m "fix(auth): log sanitized OAuth error fields, not the raw error object

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 19: Admin-editor CSP — drop `script-src 'unsafe-inline'` via nonce (Consider)

**Files:** `src/routes/admin.ts` (`ADMIN_EDITOR_CSP` ~433), the admin editor template (`src/templates/admin.ts`) that emits the inline `<script>`/`<style>`

- [ ] **Step 1:** Read `src/routes/admin.ts:420-446` and the admin template's inline blocks.
- [ ] **Step 2:** Generate a per-response nonce (`crypto.randomBytes(16).toString('base64')`), inject it into the inline `<script nonce="...">`/`<style nonce="...">` in the template, and build the CSP as `script-src 'self' 'nonce-<n>'` (drop `'unsafe-inline'`). Pass the nonce from route → template.
- [ ] **Step 3: Test** — assert the editor response CSP has no `'unsafe-inline'` in `script-src` and the inline script tag carries a matching nonce. Smoke `/admin/editor` loads (the rkr-theme-writing checklist mentions admin pages).
- [ ] **Step 4:** `npm test`; manual smoke of the editor (open `/admin`, confirm JS runs — the inline bootstrap must still execute). **Step 5: Commit**

```bash
git add src/routes/admin.ts src/templates/admin.ts test/
git commit -m "fix(admin): nonce-based CSP, drop script-src 'unsafe-inline' on editor

Hardens the page that holds post-write + token-bearing picker endpoints.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 20: Fix online-probe timer leak (Consider)

**Files:** `src/admin/online-state.ts` (~88-117)

- [ ] **Step 1:** Read `src/admin/online-state.ts:80-120`. A stale offline-scheduled `probeTimer` is only cleared in the `!wasOnline` branch.
- [ ] **Step 2: Failing test** (extend the existing online-state test) — schedule an offline probe, fire an `online` event while already online, assert the previously scheduled timer is cleared (no spurious later probe).
- [ ] **Step 3:** Clear `probeTimer` whenever a probe resolves `ok`, regardless of `wasOnline`.
- [ ] **Step 4: PASS; full suite. Step 5: Commit**

```bash
git add src/admin/online-state.ts test/admin/
git commit -m "fix(online-state): clear the re-probe timer on any ok probe

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 21: Serialize startup GC/legacy-drop against append/drain (Consider)

**Files:** `src/admin/startup.ts` (~65-75,155), `src/admin/outbox.ts` (`gcOrphansAgainstOutbox` ~125-139)

- [ ] **Step 1:** Read `src/admin/startup.ts:60-160` and `outbox.ts:120-140`. Two issues: (a) the blob GC runs fire-and-forget not under the `rkr-outbox-append` lock and can delete a just-appended blob; (b) `dropLegacyOpEntries()` is `void`-ed before `await tryDrain()`, so the first drain can observe a legacy op and flash `halted`.
- [ ] **Step 2:** (a) Acquire the `rkr-outbox-append` Web Lock around the blob sweep (or skip seqs ≥ a `nextSeq` snapshot taken under the lock). (b) `await dropLegacyOpEntries()` before the first `tryDrain()`.
- [ ] **Step 3: Test** — extend startup/outbox tests: a sweep concurrent with an in-flight append must not delete the new blob; first drain after a legacy entry doesn't surface `halted`.
- [ ] **Step 4: PASS; full suite. Step 5: Commit**

```bash
git add src/admin/startup.ts src/admin/outbox.ts test/admin/
git commit -m "fix(startup): serialize blob GC under append lock; await legacy drop

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 22: Document deliberate deviations + force-overwrite hazard in DEFERRED.md (Consider)

**Files:** `docs/DEFERRED.md`

- [ ] **Step 1:** Read `docs/DEFERRED.md` for the entry format (Source / What / Why deferred / Trigger).
- [ ] **Step 2:** Add entries for: (a) module-level mutable state in `jobs.ts` (`liveInflight`, `events`) and `config.ts` theme cache — acceptable for single-instance, revisit if multi-process; (b) single-instance scaling ceiling (`inflightRenders`/`renderSemaphore` per-process; O(n) sidecar/post full-scans); (c) `forceConflictedSave` retry hazard (no `x-rkr-last-synced-at` on the re-POST — a concurrent device edit between attempts can be lost; mitigated but explicit-user-action); (d) provider-redirect SSRF re-validation for the multi-author future (`url-safety.ts` trigger note).
- [ ] **Step 3: Commit**

```bash
git add docs/DEFERRED.md
git commit -m "docs(deferred): record single-instance deviations + force-save hazard

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 6: Final verification

### Task 23: Full gauntlet + review + deploy decision

- [ ] **Step 1:** Run the full pre-commit gauntlet manually: `npm run test:coverage` (coverage gate), plus the hooks' biome/tsc/duplicate-types/no-reexports/knip:gate/circular/size checks (run `bash .githooks/pre-commit` if it can be invoked directly, else commit a no-op to trigger it).
- [ ] **Step 2:** Run `/review-step` on the security-sensitive commits (Task 4 auth/throttle, Task 8 idempotency, Task 19 CSP) per `CLAUDE.md` (auth/security-sensitive refactors warrant an independent read).
- [ ] **Step 3:** Smoke-test per the rkr-theme-writing checklist where UI changed (Task 17 admin-styles split, Task 19 editor CSP): `/`, `/:slug`, `/admin/posts`, `/admin/login`, `/admin` editor, mobile ≤640px.
- [ ] **Step 4:** Push the branch and open a PR (or merge per `superpowers:finishing-a-development-branch`), then deploy with `deploy.sh update .` from the repo root (the deploy config supplies the host).

---

## Self-Review (author checklist — completed)

**Spec coverage:** Must-fix #1a (Task 1), #1b (Task 2), #2 (Task 8), #3a (Task 5), #3b (Task 6), #4 (Task 7), #5 (Task 3), #6 (Task 9). Should-fix: throttling (Task 4), decodeHtmlEntities (Task 10), eviction (Task 11), SESSION_COOKIE_NAME (Task 12), search catch (Task 13), prose-markdown captions (Task 14), online-save 409 toast (Task 15), admin bundle SWR (Task 16), size caps (Task 17). Consider: OAuth err logging (Task 18), CSP nonce (Task 19), online-probe timer (Task 20), startup GC/legacy races (Task 21), DEFERRED docs incl. force-save + SSRF-future (Task 22). All review findings mapped.

**Placeholder scan:** Larger refactors (Tasks 8, 9, 17, 19, 21) intentionally instruct the executor to read a named file region first because the exact current code there exceeds what is safe to transcribe blind; each still specifies exact files, the precise change, and representative code. Surgical fixes (Tasks 1, 5, 6, 7) carry complete code.

**Type consistency:** `applied-outbox.ts` API (`recordApplied`/`lookupApplied`/`pruneApplied`) is used consistently in Tasks 8. `login-throttle.ts` API (`recordFailure`/`isThrottled`/`clearFailures`/`_resetLoginThrottle`) consistent in Task 4. `savePostKey`/`atomicWrite`/`maxOutboxSeqOnDisk` referenced only within their defining tasks.

**Risk note:** Tasks 4 and 8 add a header contract (`x-rkr-device-id`) — Task 8 Step 4 explicitly checks/adds the client side; do Task 4 before Task 8 only if convenient (independent). Recommended order is sequential by task number; Phases 1–3 are the Must-fix core and should land before Phase 4+.
