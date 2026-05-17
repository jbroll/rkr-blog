# Review-Remediation Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 1 Must-fix regression and all Should-fix residuals found by the post-remediation wide-and-deep review (HEAD `382a41c`).

**Architecture:** Surgical, independently-committable fixes. Two design decisions are locked by the user: M1 = *validate the token before throttling* (in-app) **plus** strip/normalize `X-Forwarded-For` at the proxy (if its config lives in this repo, else document the hard dependency); the `_root.json#nextSeq` race = *lock all `_root` mutations* via a shared `withAppendLock`-wrapped `mutateRoot()` in `opfs-schema.ts`.

**Tech Stack:** TypeScript (ES modules, `node --test`, `--experimental-strip-types`), Fastify 5, `node:sqlite` via `src/lib/db.ts`, OPFS + Web Locks (browser), sharp/libvips.

**Conventions (from `docs/developer-quickstart.md §4` + `CLAUDE.md`):** ES modules, kebab-case filenames, no top-level side effects in `src/lib`, "let bugs propagate", 500-line cap on `src/`/`bin/` production source (tests exempt). Pre-commit gauntlet: biome / tsc(×3) / duplicate-types / no-reexports / knip:gate / circular / size / c8 coverage, **plus** a Playwright e2e + coverage ratchet whenever `src/admin/**` or `src/site/**` is staged. The e2e suite is currently STABLE (61 pass, 0 flaky) — keep it. Never `--no-verify`; if a gate fails, fix the underlying issue. `docs/DEFERRED.md` format: terse one line per item, grouped, each with `_Revisit when:_ <trigger>`; **delete an entry when it ships.**

**Test command:** `npm test` (all) or `node --test --no-warnings=ExperimentalWarning --experimental-strip-types 'test/<path>.test.ts'` (single). Coverage gate: `npm run test:coverage`. Baseline at plan start: **1134 pass, 0 fail**.

**Commit trailer (every commit):**
```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```
Run `npm test` before each commit (the pre-commit hook runs the full gauntlet anyway).

---

## File Structure

| File | Responsibility / change |
|---|---|
| `src/lib/auth-middleware.ts` | bearer path: validate token *before* any throttle check/record |
| `src/routes/auth.ts` | `/admin/auth/token-login`: validate token *before* throttle; consistent `req.ip` keying |
| `src/lib/login-throttle.ts` | bounded `failures` map (size cap); doc the proxy dependency |
| `deploy.conf` / in-repo proxy template (if present) | strip inbound `X-Forwarded-For`; else document the requirement |
| `src/admin/opfs-schema.ts` | new shared `mutateRoot()` (lock + read-modify-write); host the lock primitive |
| `src/admin/outbox.ts` | import the shared lock; `append` keeps its lock semantics via the shared primitive |
| `src/admin/draft.ts`, `src/admin/pin.ts`, `src/admin/startup.ts` | route every `_root.json` mutation through `mutateRoot()` |
| `src/lib/microsoft-graph.ts` | reject a `nextLink` not on `https://graph.microsoft.com` |
| `src/server.ts` | `migrate(db)` at boot before `buildApp` |
| `src/lib/safe-err.ts` | redact secret-pattern substrings from `message` |
| `src/lib/wp-import.ts` | collapse control chars in the imported title before YAML-quoting |
| `src/lib/originals.ts` | `imageInfo` sharp call gets `limitInputPixels` |
| `tsconfig.json` | widen `include` to type-check `test/**` |
| `.gitignore`, `docs/DEFERRED.md` | ignore `.claude/worktrees/`; drop shipped DEFERRED entries |

---

## Task 0: Worktree + baseline

**Files:** none (the worktree is created by the executing skill via the native worktree tool, branched off current `main` which equals pushed `origin/main` at `382a41c`).

- [ ] **Step 1: Confirm baseline in the worktree**

Run: `npm test`
Expected: `# pass 1134`, `# fail 0`. Record the count.

- [ ] **Step 2: Confirm clean tree + size baseline**

Run: `git status --porcelain | grep -v .claude/worktrees || echo clean` then `find src bin -name '*.ts' -exec wc -l {} + | awk '$1>500 && $2!="total"' || echo "none>500"`
Expected: `clean`; `none>500`.

---

## Task 1: M1 — validate the bearer/token credential *before* throttling

**Problem:** `isThrottled` is checked *before* `adminTokenMatchesEnv`, so once an IP hits the failure ceiling, a request carrying the **correct** `ADMIN_TOKEN` is 429'd for the whole window → renewable lockout of the sole operator. A correct token must NEVER be throttled.

**Files:**
- Modify: `src/lib/auth-middleware.ts` (bearer block, ~lines 56–85)
- Modify: `src/routes/auth.ts` (`/admin/auth/token-login`, ~lines 273–301)
- Test: `test/lib/bearer-auth.test.ts`, `test/routes/auth.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/lib/bearer-auth.test.ts` (match its existing app-injection harness; it already calls `_resetLoginThrottle()` in setup):

```ts
test('a correct bearer token is NEVER throttled even after the IP hit the failure ceiling', async () => {
  const app = await buildTestApp({ adminToken: 'correct-horse-battery-staple-very-long' });
  // Drive the IP over the ceiling with wrong tokens.
  for (let i = 0; i < 12; i++) {
    await app.inject({ method: 'POST', url: '/admin/reindex', headers: { authorization: `Bearer wrong-${i}` } });
  }
  // The very next request with the CORRECT token must succeed (not 429).
  const res = await app.inject({ method: 'POST', url: '/admin/reindex', headers: { authorization: 'Bearer correct-horse-battery-staple-very-long' } });
  assert.notEqual(res.statusCode, 429);
  assert.ok(res.statusCode < 500);
  await app.close();
});

test('wrong bearer tokens still eventually 429 (brute-force defense intact)', async () => {
  const app = await buildTestApp({ adminToken: 'correct-horse-battery-staple-very-long' });
  let saw429 = false;
  for (let i = 0; i < 40; i++) {
    const r = await app.inject({ method: 'POST', url: '/admin/reindex', headers: { authorization: `Bearer wrong-${i}` } });
    if (r.statusCode === 429) { saw429 = true; break; }
  }
  assert.equal(saw429, true);
  await app.close();
});
```

Add to `test/routes/auth.test.ts` (its harness):

```ts
test('token-login with the correct token succeeds even when the IP is over the ceiling', async () => {
  const app = await buildAuthTestApp({ adminToken: 'right-token-very-long-value' });
  for (let i = 0; i < 12; i++) {
    await app.inject({ method: 'POST', url: '/admin/auth/token-login', payload: { token: 'nope' } });
  }
  const res = await app.inject({ method: 'POST', url: '/admin/auth/token-login', payload: { token: 'right-token-very-long-value' } });
  assert.notEqual(res.statusCode, 429);
  assert.ok(res.statusCode < 400); // session created
  await app.close();
});
```

(Adapt `buildTestApp`/`buildAuthTestApp` to the real helper names in each file.)

- [ ] **Step 2: Run them; expect FAIL**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types 'test/lib/bearer-auth.test.ts' 'test/routes/auth.test.ts'`
Expected: the "correct token never throttled / succeeds over ceiling" tests FAIL (currently 429); the brute-force test passes.

- [ ] **Step 3: Reorder `src/lib/auth-middleware.ts` bearer block**

Replace the bearer block body (currently: throttle-check → match → clear/record) so the token is validated FIRST and the throttle only gates the *mismatch* path. Replace lines ~58–85 (the comment + `if (isThrottled…)` + `if (adminTokenMatchesEnv…) … else …`) with:

```ts
      // Validate the token FIRST. A correct ADMIN_TOKEN must never be
      // throttled — gating the success path on a per-IP failure tally
      // lets an attacker (or a shared NAT) lock the sole operator out
      // (the per-IP key rides on X-Forwarded-For; see login-throttle).
      // The throttle only ever gates the WRONG-token path.
      if (adminTokenMatchesEnv(bearer)) {
        req.user = BEARER_USER;
        clearFailures(req.ip); // clean success drops any prior tally
        return;
      }
      // Wrong token: this is the brute-force signal.
      if (isThrottled(req.ip)) {
        reply
          .code(429)
          .header('retry-after', String(Math.ceil(WINDOW_MS / 1000)))
          .send({ error: 'too many failed login attempts' });
        return;
      }
      recordFailure(req.ip);
      // user stays null; requireUser issues the existing 401.
      return;
```

- [ ] **Step 4: Reorder `src/routes/auth.ts` `/admin/auth/token-login`**

Move the `isThrottled` 429 gate so it runs only on a token mismatch. Replace the handler prologue (the `const ip = …`, the early `if (isThrottled(ip, tokenLoginMax)) {…429…}` block, the empty/`!provided` 400, the `!process.env.ADMIN_TOKEN` 503, and the `if (!adminTokenMatchesEnv(provided)) { recordFailure; …401 }`) so the order is:

```ts
    const ip = typeof req.ip === 'string' && req.ip !== '' ? req.ip : null;
    const provided = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!provided) {
      req.log.warn({ ip, ua: req.headers['user-agent'] }, 'token-login: empty token');
      return reply.code(400).send({ error: 'token required' });
    }
    if (!process.env.ADMIN_TOKEN) {
      req.log.warn({ ip }, 'token-login: ADMIN_TOKEN not configured');
      return reply.code(503).send({ error: 'token login not configured' });
    }
    if (adminTokenMatchesEnv(provided)) {
      // Correct token: NEVER throttled. Clear any prior tally.
      if (ip) clearFailures(ip);
      // ... fall through to the existing success path (findOrCreateTokenAdmin/createSession/cookie) ...
    } else {
      // Wrong token: throttle gates only this path.
      if (ip && isThrottled(ip, tokenLoginMax)) {
        const retryAfterSec = Math.ceil(WINDOW_MS / 1000);
        req.log.warn({ ip, retryAfter: retryAfterSec }, 'token-login: rate-limited');
        return reply.code(429).header('retry-after', String(retryAfterSec)).send({ error: 'too many failed login attempts' });
      }
      if (ip) recordFailure(ip);
      req.log.warn({ ip, ua: req.headers['user-agent'] }, 'token-login: token mismatch');
      return reply.code(401).send({ error: 'invalid token' });
    }
```

Keep the existing success body (the `findOrCreateTokenAdmin`/`createSession`/Set-Cookie/redirect code that currently follows the old `clearFailures(ip)`) — move it inside the `if (adminTokenMatchesEnv(provided))` branch, unchanged. The `ip` is now `string | null` (note: this also fixes S2's `?? ''` bucket-collapse — a missing IP is treated as "don't throttle / don't record" rather than collapsing every unknown-IP client into one shared `''` bucket; the bearer middleware already uses raw `req.ip` which Fastify guarantees is a string).

- [ ] **Step 5: Run the tests; expect PASS, then full suite**

Run: `node --test … 'test/lib/bearer-auth.test.ts' 'test/routes/auth.test.ts'` then `npm test`
Expected: all PASS; full suite ≥ 1134 + 3 new, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth-middleware.ts src/routes/auth.ts test/lib/bearer-auth.test.ts test/routes/auth.test.ts
git commit -m "fix(auth): validate token before throttling so a correct token never 429s

isThrottled ran before adminTokenMatchesEnv, so once an IP hit the
failure ceiling even the correct ADMIN_TOKEN was rejected for the whole
window — a renewable lockout of the sole operator (per-IP key rides on
X-Forwarded-For). Throttle now gates only the wrong-token path; a
missing req.ip no longer collapses clients into one shared bucket.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Throttle key-trust hardening — XFF strip + bounded map

**Files:**
- Modify: `src/lib/login-throttle.ts` (bound `failures`)
- Inspect/Modify: `deploy.conf` and any in-repo proxy/apache template; else `docs/DEFERRED.md` + the `login-throttle.ts` header
- Test: `test/lib/login-throttle.test.ts`

- [ ] **Step 1: Locate the proxy config**

Run: `grep -rl -i 'ProxyPass\|X-Forwarded-For\|VirtualHost\|apache' . --include='*.conf' --include='*.tmpl' --include='*.template' 2>/dev/null | grep -v node_modules | grep -v .git` and read `deploy.conf`. Determine whether the Apache/reverse-proxy vhost that fronts this app is templated **in this repo** (the deploy.sh module templates live OUTSIDE this repo at `/home/john/src/deploy.sh/...`, so it likely is NOT — confirm).

- [ ] **Step 2: Strip XFF (if in-repo) OR document the hard dependency**

- **If an in-repo Apache/proxy config exists:** add, immediately before the `ProxyPass`/`ProxyPassReverse` to the Node app, a directive that drops any client-supplied `X-Forwarded-For` so only the trusted hop sets it:
  ```apache
  RequestHeader unset X-Forwarded-For
  ```
  (and ensure `mod_headers` is enabled in the same config). Commit it with the rest of Task 2.
- **If the proxy config is NOT in this repo:** do not fabricate one. Instead (a) strengthen the `src/lib/login-throttle.ts` header comment from "depends on trustProxy:'loopback'" to an explicit operational REQUIREMENT that the fronting proxy MUST `RequestHeader unset X-Forwarded-For` (the per-IP control is void otherwise), and (b) add a `docs/DEFERRED.md` line under the security group: `**Proxy must strip inbound X-Forwarded-For** — login-throttle per-IP integrity depends on it; the vhost is templated in the external deploy.sh repo, not here. _Revisit when:_ the deploy proxy config is brought in-repo or the throttle key is changed.` Report exactly which branch you took and why.

- [ ] **Step 3: Failing test — bounded map**

Add to `test/lib/login-throttle.test.ts`:

```ts
import { recordFailure, _resetLoginThrottle, _loginThrottleSize } from '../../src/lib/login-throttle.ts';

test('failures map is bounded under an in-window IP spray', () => {
  _resetLoginThrottle();
  for (let i = 0; i < 50_000; i++) recordFailure(`10.0.${(i >> 8) & 255}.${i & 255}`);
  // Hard cap keeps the tally table bounded even with no expiries yet.
  assert.ok(_loginThrottleSize() <= 10_000, `expected ≤10000, got ${_loginThrottleSize()}`);
});
```

Run it: FAILS (map currently grows to 50k within the window — `sweepExpired` only drops *expired* entries).

- [ ] **Step 4: Implement a hard size cap**

In `src/lib/login-throttle.ts` add a `MAX_TRACKED_IPS = 10_000` const (documented: an attacker spraying rotating IPs within one window can't grow the tally unbounded; evicting an arbitrary existing entry only resets *that* IP's count, which is safe — it can't help a brute-forcer because they'd need the evicted IP to also be theirs). In `recordFailure`, in the new-window branch after `sweepExpired()`, before `failures.set(...)`:

```ts
  if (failures.size >= MAX_TRACKED_IPS) {
    // Still over cap after sweeping live (unexpired) entries → an
    // in-window IP-spray flood. Drop the oldest-inserted entry; Map
    // preserves insertion order so the first key is the oldest.
    const oldest = failures.keys().next().value;
    if (oldest !== undefined) failures.delete(oldest);
  }
```

- [ ] **Step 5: Run tests; expect PASS; full suite**

Run the throttle test file then `npm test`. Expected: PASS; 0 fail. c8 for `src/lib/login-throttle.ts` ≥ 90/75/90 (cover the cap branch).

- [ ] **Step 6: Commit**

```bash
git add src/lib/login-throttle.ts test/lib/login-throttle.test.ts <proxy config or docs/DEFERRED.md>
git commit -m "fix(auth): bound the throttle tally map; harden/document XFF key-trust

An in-window rotating-IP spray could grow the per-IP failure Map
unbounded (sweepExpired only drops expired entries). Add a hard size
cap with oldest-insertion eviction, and <strip inbound X-Forwarded-For
at the proxy | document the proxy-must-strip-XFF requirement>.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Lock all `_root.json` mutations (`mutateRoot`)

**Problem:** `outbox.append()` does the `nextSeq` read-modify-write under the `rkr-outbox-append` Web Lock, but `currentDraftId` writers (`draft.ts` `getOrCreateDraftId`/`clearDraft`, `pin.ts`, `startup.ts` `?new=1`) and `ensureSchema` rewrite the whole `_root.json` *without* the lock. A `currentDraftId` write that read `_root` before a concurrent `append`'s `nextSeq` bump persists the stale `nextSeq` → seq collision → a queued offline edit silently lost.

**Files:**
- Modify: `src/admin/opfs-schema.ts` (host the lock primitive + add `mutateRoot`)
- Modify: `src/admin/outbox.ts` (import the shared lock; reuse it)
- Modify: `src/admin/draft.ts`, `src/admin/pin.ts`, `src/admin/startup.ts` (use `mutateRoot`)
- Test: `test/admin/startup-races.test.ts` (extend; it already has the `MockLockManager` + write-gate harness)

- [ ] **Step 1: Move the lock primitive into `opfs-schema.ts` and add `mutateRoot`**

In `src/admin/opfs-schema.ts` add (near `readRoot`/`writeRoot`):

```ts
/** The single Web Lock serialising every read-modify-write of
 * `_root.json`. Owned here (the schema module) so both the outbox
 * append path and the currentDraftId writers share ONE lock and can
 * never interleave a stale nextSeq over a concurrent bump. */
export const ROOT_LOCK = 'rkr-outbox-append';

export function withRootLock<T>(fn: () => Promise<T>): Promise<T> {
  return navigator.locks.request(ROOT_LOCK, fn) as Promise<T>;
}

/** Atomic read-modify-write of `_root.json` under ROOT_LOCK. `fn`
 * receives the current root (or a fresh one if absent) and returns
 * the next root to persist. Every currentDraftId/nextSeq mutation
 * MUST go through this so concurrent tabs can't clobber each other. */
export async function mutateRoot(
  fn: (root: OpfsRoot) => OpfsRoot | Promise<OpfsRoot>
): Promise<OpfsRoot> {
  return withRootLock(async () => {
    const current = (await readRoot()) ?? makeRoot();
    const next = await fn(current);
    await writeRoot(next);
    return next;
  });
}
```

Keep `makeRoot` reachable (it already exists at ~line 53). `ROOT_LOCK`'s string value MUST equal the existing `APPEND_LOCK` (`'rkr-outbox-append'`) so it is literally the same lock.

- [ ] **Step 2: Point `outbox.ts` at the shared lock (no behavior change)**

In `src/admin/outbox.ts`: replace the local `const APPEND_LOCK = 'rkr-outbox-append'` + private `withAppendLock` with an import of `withRootLock as withAppendLock` (and `ROOT_LOCK` if referenced elsewhere) from `./opfs-schema.ts`. `append()` and `gcUnderAppendLock` keep calling `withAppendLock(...)` exactly as before — same lock name, same semantics, just centrally owned. (No cycle: `outbox.ts` already imports `readRoot`/`writeRoot` from `opfs-schema.ts`.) Do NOT convert `append` to `mutateRoot` — `append` must hold the lock across BOTH the `nextSeq` bump AND the entry blob+JSON write, which `mutateRoot` does not cover; it stays `withAppendLock(async () => { … readRoot → writeRoot(next) → write entry … })`.

- [ ] **Step 3: Route the `currentDraftId` writers through `mutateRoot`**

- `src/admin/draft.ts:55-57` `getOrCreateDraftId`: replace the `readRoot()` + `if (root.currentDraftId) return …` + `writeRoot({ ...root, currentDraftId: draftId })` with:
  ```ts
  let chosen = draftId;
  await mutateRoot((root) => {
    if (root.currentDraftId) { chosen = root.currentDraftId; return root; }
    return { ...root, currentDraftId: draftId };
  });
  return chosen;
  ```
  (Preserve the existing early-return semantics: if a draft already exists, keep it and return it; the read-decide-write is now atomic under the lock.)
- `src/admin/draft.ts:174-176` `clearDraft`: replace the `readRoot` + conditional `writeRoot(rest)` with:
  ```ts
  await mutateRoot((root) => {
    if (root.currentDraftId !== draftId) return root;
    const { currentDraftId: _drop, ...rest } = root;
    return rest as OpfsRoot;
  });
  ```
- `src/admin/pin.ts:96` `await writeRoot({ ...root, currentDraftId: draftId })` → `await mutateRoot((root) => ({ ...root, currentDraftId: draftId }))` (drop the now-unused earlier bare `readRoot` for this write if it was only used to spread; re-read inside `mutateRoot`). Preserve the "body+meta first, currentDraftId flip last" ordering — `mutateRoot` only replaces the final flip, not the preceding body/meta writes.
- `src/admin/startup.ts:102` the `?new=1` branch `await writeRoot({ ...root, currentDraftId: '' })` → `await mutateRoot((root) => ({ ...root, currentDraftId: '' }))`.
Update imports in those three files: import `mutateRoot` from `./opfs-schema.ts` (they already import `readRoot`/`writeRoot` from there; drop now-unused `writeRoot`/`readRoot` imports if nothing else uses them — knip will flag dead imports).

- [ ] **Step 4: `ensureSchema` writes under the lock too**

In `src/admin/opfs-schema.ts` `ensureSchema`: the two `writeJson(ROOT_PATH, …)` writes (the fresh/floor-seeded write ~line 102 and the migration write ~line 125) must not interleave with a concurrent `append`. Wrap each `writeJson(ROOT_PATH, x)` in `ensureSchema` with `withRootLock(async () => { await writeJson(ROOT_PATH, x); })` — OR restructure the fresh-root branch to use `mutateRoot` (preferred for the fresh branch: it already computes `makeRoot()` + `maxOutboxSeqOnDisk()` floor; do the floor read inside the locked callback so the floor and the write are atomic). Keep `maxOutboxSeqOnDisk`'s logic unchanged. The migration path (`working`) can stay a `withRootLock`-wrapped `writeJson`. Do NOT change WHAT is written (schema version, deviceId, floor logic) — only add the lock.

- [ ] **Step 5: Failing test — stale-nextSeq clobber**

Extend `test/admin/startup-races.test.ts` (reuse its `MockLockManager` + OPFS mock + write-gate). Model the race:

```ts
test('a currentDraftId write cannot roll back a concurrent append\'s nextSeq bump', async () => {
  // root starts {nextSeq:5}; an append() is in-flight (lock held,
  // root rewritten to nextSeq:6, parked before releasing). A
  // getOrCreateDraftId() that read root at nextSeq:5 must NOT persist
  // nextSeq:5 — mutateRoot serialises it AFTER append releases, so it
  // sees nextSeq:6 and preserves it.
  // (drive via the existing gate/lock harness; assert the final
  //  _root.json has nextSeq >= 6 AND currentDraftId set.)
});
```

Run it; confirm it FAILS against the un-locked writers (pre-Step-3 behavior would persist `nextSeq:5`). If modelling the exact interleave with the harness is impractical, instead assert the structural invariant: every `_root.json` writer in `src/admin/{draft,pin,startup}.ts` and `opfs-schema.ts:ensureSchema` calls `mutateRoot`/`withRootLock` (grep-based assertion in the test that no `writeRoot(`/`writeJson(ROOT_PATH` occurs outside a locked context) — and keep a behavioral test of `mutateRoot` itself (two concurrent `mutateRoot` calls serialise; the second sees the first's result).

- [ ] **Step 6: Run; expect PASS; full suite + e2e ratchet**

Run the test file, then `npm test`. The commit stages `src/admin/**` → the pre-commit e2e ratchet runs; it must pass (stable suite). If a NEW e2e failure is caused by this change, that's a real problem — report BLOCKED; a different pre-existing flake → re-run once + report precisely.

- [ ] **Step 7: Commit**

```bash
git add src/admin/opfs-schema.ts src/admin/outbox.ts src/admin/draft.ts src/admin/pin.ts src/admin/startup.ts test/admin/startup-races.test.ts
git commit -m "fix(opfs): serialise all _root.json mutations under the append lock

currentDraftId writers (draft/pin/?new=1) and ensureSchema rewrote
_root.json without the rkr-outbox-append lock, so a stale nextSeq could
clobber a concurrent append()'s bump → seq collision → silent loss of a
queued offline edit. New shared mutateRoot()/withRootLock in
opfs-schema owns the one lock; every _root mutation goes through it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: OneDrive `nextLink` SSRF guard

**Problem:** `microsoft-graph.ts` fetches `opts.nextLink` (a client-supplied query param via `/admin/integrations/onedrive/files?nextLink=`) server-side with the user's Graph bearer token, no host allowlist → token-exfil / internal SSRF.

**Files:**
- Modify: `src/lib/microsoft-graph.ts` (~lines 52–70)
- Test: the microsoft-graph / onedrive test file (locate: `ls test | grep -ri onedrive\|graph`)

- [ ] **Step 1: Failing test**

Add (match the existing graph/onedrive test harness; it injects a `fetcher`):

```ts
test('listOneDriveChildren rejects a nextLink not on graph.microsoft.com', async () => {
  await assert.rejects(
    () => listOneDriveChildren('tok', { nextLink: 'http://169.254.169.254/latest/meta-data/', fetcher: async () => new Response('{}') }),
    /unsafe|invalid.*nextLink|graph\.microsoft\.com/i
  );
});
test('a graph.microsoft.com nextLink is accepted', async () => {
  const r = await listOneDriveChildren('tok', {
    nextLink: 'https://graph.microsoft.com/v1.0/me/drive/items/x/children?$skiptoken=abc',
    fetcher: async () => new Response(JSON.stringify({ value: [] }))
  });
  assert.ok(r);
});
```

(Use the real exported function name — likely `listOneDriveChildren`/`listChildren`; read the file.)

- [ ] **Step 2: Run; expect FAIL** (oversized/SSRF nextLink currently fetched).

- [ ] **Step 3: Implement the origin allowlist**

In `src/lib/microsoft-graph.ts` where `opts.nextLink` is consumed (`if (opts.nextLink) { fetchUrl = opts.nextLink; }`), validate it first:

```ts
  if (opts.nextLink) {
    let u: URL;
    try { u = new URL(opts.nextLink); } catch { throw new Error('invalid nextLink'); }
    // Microsoft Graph paginates only via graph.microsoft.com URLs.
    // Anything else is an SSRF attempt with the user's bearer token.
    if (u.protocol !== 'https:' || u.host !== 'graph.microsoft.com') {
      throw new Error('unsafe nextLink (must be https://graph.microsoft.com)');
    }
    fetchUrl = opts.nextLink;
  }
```

Confirm the route (`src/routes/integrations-onedrive.ts`) surfaces this as a clean 4xx (it should already catch errors → sanitized response; verify it doesn't leak the message — if it returns `err.message` raw, return a generic "invalid request" and log detail server-side, consistent with `/admin/import/url`).

- [ ] **Step 4: Run; PASS; full suite. Step 5: Commit**

```bash
git add src/lib/microsoft-graph.ts src/routes/integrations-onedrive.ts test/<graph test>
git commit -m "fix(onedrive): reject a nextLink not on graph.microsoft.com (SSRF)

The OneDrive pagination nextLink (client-supplied) was fetched
server-side with the user's Graph bearer token and no host allowlist —
token-exfil / internal SSRF. Pin it to https://graph.microsoft.com.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `migrate(db)` at boot

**Files:**
- Modify: `src/server.ts` (`startServer`, where `open(p.db)` happens, before `buildApp`)
- Modify: `docs/DEFERRED.md` (delete the now-shipped "startServer skips migrate" entry)
- Test: `test/server.test.ts` or a focused boot test

- [ ] **Step 1: Read `src/server.ts` `startServer`** — find `open(p.db)`/the db construction and the `migrate` import (it's used by `runReindex`; `import { migrate } from './lib/migrate.ts'`). Confirm `migrate` is idempotent (it records applied versions; re-running is a no-op).

- [ ] **Step 2: Failing test**

Add a test that builds the server's db path with NO migrations applied, starts the app, and asserts `/search?q=x` returns a normal (FTS-available) empty result with **no** reliance on a later reindex — i.e. `posts_fts` exists immediately after boot. Concretely (adapt to the server test harness): construct a fresh site dir, run `startServer`-equivalent wiring (or the smallest unit: call the boot path that opens the db + buildApp), assert `db` has table `posts_fts` right after boot (query `sqlite_master`). It must FAIL pre-change (no migrate at boot → no `posts_fts` until reindex).

- [ ] **Step 3: Implement** — in `startServer`, immediately after `const db = open(p.db)` (the long-lived connection passed to `buildApp`) and before `buildApp(...)`, add `migrate(db);` (synchronous, matching how `runReindex` calls it). Leave the lazy FTS probe in `public.ts` as defense-in-depth (do not remove it).

- [ ] **Step 4: Run; PASS; full suite.**

- [ ] **Step 5: Drop the shipped DEFERRED entry** — in `docs/DEFERRED.md` delete the line about `startServer` not running `migrate(db)` (it has shipped).

- [ ] **Step 6: Commit**

```bash
git add src/server.ts docs/DEFERRED.md test/<server test>
git commit -m "fix(server): migrate(db) at boot so FTS/search works on a clean deploy

startServer never migrated its long-lived connection; a fresh deploy
left /search silently empty until the first reindex. Migrate at boot
(idempotent); the lazy probe stays as defense-in-depth.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `safeErr` scrubs secret patterns from `message`

**Files:**
- Modify: `src/lib/safe-err.ts`
- Test: `test/lib/safe-err.test.ts`

- [ ] **Step 1: Failing test**

```ts
test('safeErr redacts token/secret patterns embedded in message', () => {
  const e = new Error('exchange failed: code=AUTHCODE123 refresh_token=rt_secret access_token=at_secret client_secret=cs_secret');
  const s = safeErr(e);
  assert.doesNotMatch(s.message ?? '', /AUTHCODE123|rt_secret|at_secret|cs_secret/);
  assert.match(s.message ?? '', /exchange failed/); // non-secret context preserved
});
test('safeErr still returns only name/message/code (no extra fields)', () => {
  const e = Object.assign(new Error('x'), { response: { token: 'leak' }, code: 'EBADR' });
  assert.deepEqual(safeErr(e), { name: 'Error', message: 'x', code: 'EBADR' });
});
```

Run: FAILS (message currently passes secrets through verbatim).

- [ ] **Step 2: Implement redaction**

In `src/lib/safe-err.ts`, add a `redact(msg: string)` that replaces secret-bearing tokens, then apply it to the message field:

```ts
function redact(msg: string): string {
  return msg
    .replace(/\b(code|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization|bearer)\b\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]'); // long opaque tokens/JWTs
}
```

Use `redact(e.message)` for the message in the object branch and `redact(err)` in the string branch. Update the docstring: it now redacts common secret patterns from `message` (best-effort) in addition to stripping non-allowlisted fields; note the long-token rule may redact long non-secret identifiers (acceptable for an error log).

- [ ] **Step 3: Run; PASS; full suite.** c8 for `src/lib/safe-err.ts` ≥ 90/75/90 (cover both branches + the long-token rule + a no-secret message unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/lib/safe-err.ts test/lib/safe-err.test.ts
git commit -m "fix(safe-err): redact secret patterns from error message before logging

safeErr stripped non-allowlisted fields but passed message verbatim; an
OAuth provider can embed codes/tokens/secrets in Error.message. Redact
key=value secret pairs and long opaque tokens.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: WP import title — collapse control chars before YAML-quoting

**Files:**
- Modify: `src/lib/wp-import.ts` (`renderFrontmatter`, ~line 231)
- Test: `test/lib/wp-import.test.ts`

- [ ] **Step 1: Failing test**

```ts
test('a WP title with an encoded newline does not break frontmatter / drop the post', async () => {
  // title.rendered with &#10; (decodeHtmlEntities turns it into \n)
  const post = makeWpPost({ title: { rendered: 'Line one&#10;Line two' } }); // adapt to the test factory
  const md = importPostToMarkdown(post /* … */);                              // adapt to real fn
  const parsed = parsePost(md /* … */);                                       // must NOT throw
  assert.ok(parsed.frontmatter.title.length > 0);
  assert.doesNotMatch(parsed.frontmatter.title, /[\r\n]/);
});
```

Run: FAILS (current emits a literal newline inside the double-quoted scalar → `parsePost` throws → `runReindex` skips the post).

- [ ] **Step 2: Implement** — in `renderFrontmatter`, change the title escaping to collapse control whitespace first:

```ts
  const titleEsc = decodeHtmlEntities(post.title.rendered)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
```

(A title is a single line by definition; collapsing is lossless in practice. The `\\`→`\\\\` then `"`→`\\"` ordering is the existing, correct order — keep it.)

- [ ] **Step 3: Run; PASS; full suite. Step 4: Commit**

```bash
git add src/lib/wp-import.ts test/lib/wp-import.test.ts
git commit -m "fix(wp-import): collapse control chars in title before YAML-quoting

A WP title with an encoded newline (&#10;) decoded into a real newline
inside the double-quoted frontmatter scalar, making parsePost throw so
reindex silently dropped the whole post. Collapse \\r\\n\\t to a space.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `imageInfo` sharp call gets a pixel limit

**Files:**
- Modify: `src/lib/originals.ts` (~line 338)

- [ ] **Step 1:** `SHARP_INGEST_PIXEL_LIMIT` is already imported in `originals.ts` (line 19). Change `await sharp(found.path).metadata()` to:

```ts
    const meta = await sharp(found.path, {
      limitInputPixels: SHARP_INGEST_PIXEL_LIMIT,
      failOn: 'error'
    }).metadata();
```

(Matches every other sharp call in the file — lines 206/219 already use this exact options shape.)

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean; `npm test` 0 fail (option-only; existing originals/image tests must still pass). No new test required (consistency change; metadata() doesn't decode pixels — there is no behavioral assertion to add that wouldn't be a sharp-internals test).

- [ ] **Step 3: Commit**

```bash
git add src/lib/originals.ts
git commit -m "fix(image): cap imageInfo sharp.metadata() at SHARP_INGEST_PIXEL_LIMIT

Only sharp call in the codebase without limitInputPixels; latent
defense-in-depth gap (passthrough/future-ingest path). Matches the
rest of originals.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Type-check the whole `test/**` tree

**Problem:** `tsconfig.json` `include` is `"test/*.ts"` (top-level only). 122 subdir test files — including every new safety-critical module's test — are never type-checked by the gauntlet; type drift ships green.

**Files:**
- Modify: `tsconfig.json` (`include`)
- Modify: any `test/**` file with a real type error surfaced by the widen
- Modify: `docs/DEFERRED.md` (delete the now-shipped "gauntlet tsc-include misses test subdirs" entry)

> **Scope warning for the implementer:** widening `include` will surface every latent type error across ~122 previously-unchecked test files. Several were fixed earlier this session (search/online-state/startup-races/opfs mocks) but others may remain. These are real defects — fix them (correct the mock/fixture types; no `any`, no broad-union, no `@ts-ignore` unless a genuine 3rd-party-types gap with a one-line justified `// @ts-expect-error <reason>`). If the surfaced error count is large but mechanical (mock typings, `possibly-undefined` indexing, missing generics), fix them all. If it reveals a *structural* problem (e.g. a test importing a module under `--experimental-strip-types` patterns tsc can't resolve), STOP and report NEEDS_CONTEXT with the categorised error list before mass-editing.

- [ ] **Step 1: Widen the include**

In `tsconfig.json` change `"test/*.ts"` → `"test/**/*.ts"`. Keep the other entries.

- [ ] **Step 2: Enumerate the damage**

Run: `npx tsc --noEmit 2>&1 | tee /tmp/tsc-test-widen.log | grep -c 'error TS'` then `grep 'error TS' /tmp/tsc-test-widen.log | sed 's/(.*//' | sort -u`
Record the count and the unique file list. If 0 → go to Step 4.

- [ ] **Step 3: Fix every surfaced error**

For each file, fix the *real* type defect (properly type mocks/fixtures to the production interface; assert non-null on guaranteed array access; add generics to match the production signature). Do NOT weaken production types to satisfy a test. Re-run `npx tsc --noEmit` until clean. Run `npm test` after — runtime behavior must be unchanged (these are type-only fixes; `# pass` count unchanged).

- [ ] **Step 4: Drop the shipped DEFERRED entry**

Delete the `docs/DEFERRED.md` line about `test/**` subdirs not being type-checked (it has shipped).

- [ ] **Step 5: Verify the gauntlet now enforces it**

Run: `npm test` (0 fail) and `npx tsc --noEmit` (clean). The pre-commit gauntlet will now type-check all test files going forward.

- [ ] **Step 6: Commit** (one commit; if the fix set is large, the diff is still one logical change: "make test/** type-check")

```bash
git add tsconfig.json docs/DEFERRED.md test/
git commit -m "fix(tsconfig): type-check the whole test/** tree; fix surfaced errors

include was test/*.ts (top-level only), so ~122 subdir test files —
incl. every new safety-critical module's test — were never type-checked
and type drift shipped green. Widen to test/**/*.ts and fix the real
type defects it surfaces (mock/fixture typings).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Ignore `.claude/worktrees/`; drop remaining shipped DEFERRED entries

**Files:**
- Modify: `.gitignore`
- Delete (filesystem): stale `.claude/worktrees/agent-a57be6d5f1f479f79`
- Modify: `docs/DEFERRED.md` (final sweep)

- [ ] **Step 1: gitignore + stale-tree removal**

Append `.claude/worktrees/` to `.gitignore` (it must not be tracked or show in `git status`; it holds stale duplicate source/migration files). Then, from the MAIN repo root (not the active worktree), remove the stale tree if present:
`git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel` → `rm -rf <main-root>/.claude/worktrees/agent-a57be6d5f1f479f79` (only that stale dir; do NOT remove the active execution worktree). Verify `git check-ignore -q .claude/worktrees && echo ignored`.

- [ ] **Step 2: DEFERRED final sweep**

Read `docs/DEFERRED.md`. Confirm the entries shipped by THIS plan are gone (FTS migrate-at-boot — Task 5; test/** tsc-include — Task 9). Delete any other entry now resolved by this plan's commits. Be conservative (only clearly-tied). Report what you deleted.

- [ ] **Step 3: Verify + Commit**

Run `npm test` (sanity, 0 fail — non-code). 
```bash
git add .gitignore docs/DEFERRED.md
git commit -m "chore: gitignore .claude/worktrees; drop shipped DEFERRED entries

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Final verification + holistic review + finish

- [ ] **Step 1:** `npm run test:coverage` (exit 0, coverage gate green) and `find src bin -name '*.ts' -exec wc -l {} + | awk '$1>500 && $2!="total"'` (none) and `npx tsc --noEmit` (clean) and the circular + knip:gate scripts (clean).
- [ ] **Step 2:** Dispatch a final holistic reviewer over the whole follow-up range (worktree base..HEAD): verify the 11 fixes integrate coherently, no fix undid another (esp. Task 1↔2 throttle ordering + Task 3 `_root` lock reusing the *same* lock string `outbox.append` uses — confirm `ROOT_LOCK === 'rkr-outbox-append'` and `append` still serialises against the new `mutateRoot` callers), the M1 reorder didn't weaken brute-force defense, and the Task 9 widen didn't mask errors via suppressions. SHIP / DON'T-SHIP verdict.
- [ ] **Step 3:** Use `superpowers:finishing-a-development-branch` to complete (the user works on `main`; the worktree branched off it — present merge/push/deploy options and execute the choice).

---

## Self-Review (author checklist — completed)

**Spec coverage:** M1 → Task 1 (+ S2 ip-bucket folded into Task 1 Step 4, + XFF/S6 → Task 2). `_root` race → Task 3. OneDrive nextLink SSRF → Task 4. FTS migrate-at-boot → Task 5. safeErr message → Task 6. WP title \n → Task 7. imageInfo cap → Task 8. tsconfig test/** → Task 9. .claude/worktrees gitignore + DEFERRED sweep → Task 10. Every Must/Should from the review synthesis is mapped. (Consider-tier items intentionally out of scope per the user's "Must and Should" instruction; they remain in DEFERRED where applicable.)

**Placeholder scan:** Concrete code given for every surgical fix. Tasks 1/3/9 instruct reading a named region first because exact surrounding lines shift; each still gives exact files, the precise transformation, and real test code. Task 9 is explicitly flagged as potentially large with an escalation trigger (categorised error list) rather than a blind "fix errors".

**Type/name consistency:** `ROOT_LOCK`/`withRootLock`/`mutateRoot` (Task 3) used consistently; `ROOT_LOCK` value is pinned equal to the existing `'rkr-outbox-append'` so it is the same lock `outbox.append`/`gcUnderAppendLock` hold. `safeErr` shape `{name?,message?,code?}` unchanged (Task 6 only transforms `message`). `_loginThrottleSize`/`_resetLoginThrottle` (Task 2) are the existing test-only exports. `SHARP_INGEST_PIXEL_LIMIT` (Task 8) is already imported in `originals.ts`.

**Risk note:** Task 3 is the highest-risk (concurrency + touches the append lock). It must keep `ROOT_LOCK === 'rkr-outbox-append'` or `append` and `mutateRoot` would take *different* locks and the race would remain. Task 9's blast radius is unknown until Step 2 — the escalation trigger bounds it. Tasks 1/2 are sequential (both touch the throttle); do Task 1 then Task 2.
