# Writing UI tests for rkr-blog

Practical guidelines for the e2e suite. Two layers:

1. **Upstream fundamentals** — short, link-heavy. The Playwright team
   maintains a canonical best-practices doc; we don't try to
   re-explain it. Read [playwright.dev/docs/best-practices][pw-bp]
   first.
2. **Project-specific** — the patterns and gotchas particular to this
   codebase. Hard-won from the existing 7 specs.

[pw-bp]: https://playwright.dev/docs/best-practices

---

## Quick orientation

| Path | What |
|---|---|
| `test-e2e/*.spec.ts` | The specs. One per logical flow. |
| `test-e2e/coverage-fixtures.ts` | Custom `test` fixture that wraps Playwright's `baseTest` to capture V8 coverage per spec. **Always import `test` + `expect` from here, not `@playwright/test`** — otherwise no coverage data is collected for the spec. |
| `test-e2e/server-runner.ts` | Boots a fresh `buildApp()` against a tmp `SITE_ROOT` for the duration of a run. Single shared instance across all specs. |
| `test-e2e/global-teardown.ts` | Generates the lcov + HTML report after the suite completes. |
| `playwright.config.ts` | Wires the webServer + global teardown. `workers: 1` (the suite shares one server). |
| `coverage-baseline.json` | Per-file lcov baseline for the pre-commit ratchet (see §10). |
| `test/site/` | Unit tests for browser-only code that Playwright can't reach (e.g. `sw-core.test.ts` for the service worker). These run under c8, not Playwright; see §10 for the ratchet's `EXEMPT` carve-out. |

Run:

```bash
npm run test:e2e            # full suite; ~7s; produces coverage/e2e/
npm run test:e2e -- --headed   # see what's happening in chromium
npm run test:e2e -- editor-flow.spec.ts -g "rotate"   # one test
```

---

## 1. Upstream fundamentals (per Playwright docs)

- **Selector preference order**: role-based (`getByRole('button', { name: /Save/ })`), then test ids and user-facing attributes (`getByLabel('Admin token')`), then ids (`page.locator('#rkr-figure-attrs')`). Avoid XPath / CSS class selectors — the DOM changes, those break.
- **Web-first assertions**: use `await expect(locator).toX(...)` with timeouts, not `expect(await locator.isVisible()).toBe(true)`. The former auto-retries; the latter is one-shot and flaky.
- **Test isolation**: every test gets a fresh `page` (and fresh cookies / storage). No state-via-side-channel between tests beyond what's on disk in `SITE_ROOT`.
- **Debugging**: `--trace on` in `playwright.config.ts` (already set to `on-first-retry`); `npx playwright show-trace` opens the recorded run.
- **No `page.waitForTimeout(...)`** ever. Always wait on a condition (text appears, response arrives, locator becomes attached). Sleeps are flake-bait.

The above is generic Playwright wisdom and it all applies. Specifics below are where this project diverges.

---

## 2. Selectors we use here (in priority order)

| Surface | Use | Example from the suite |
|---|---|---|
| Form inputs with labels | `page.getByLabel('Admin token')` | `login.spec.ts:14` |
| Buttons with visible text | `page.getByRole('button', { name: /Sign in with token/ })` | `login.spec.ts:24` |
| Stable DOM ids the SPA owns | `page.locator('#rkr-image-edit')` | `editor-flow.spec.ts` throughout |
| Selection within a multi-thumb figure | `page.locator('img[data-cell-index="1"]')` | `editor-flow.spec.ts:248` |
| Status line as a DOM signal | `await expect(page.locator('#rkroll-admin-status')).toContainText(/^saved edits /, { timeout: 10_000 });` | many places |

The status-line pattern is **load-bearing**. The admin SPA writes "uploaded …", "rotate …", "saved edits …" via `setStatus()` after async ops complete. Most editor flows have no other DOM signal that tells you the canvas pipeline + bake-upload + sidecar-write all succeeded. **When you add a new editor op, add a `setStatus(...)` line for it** so e2e has something to wait on.

---

## 3. Test isolation in a content-addressed app

Every upload is keyed by `sha256(bytes)`. **Two tests that upload the same PNG bytes share one sidecar** — including its ops, its baseline, its bake. This bites in two ways:

- **Sidecar state leaks.** If test A applies a rotate and saves, test B inserting "the same image" sees `ops=[rotate]` already on the sidecar. Whatever assertions test B makes about "fresh state" are wrong.
- **Race against `ensureLocalState`.** The image-edit panel populates from a server fetch. If the server has prior ops, the panel's edit-list grows asynchronously. Snapshots taken before that fetch resolves see different counts than snapshots after.

**The pattern**: each test that uploads gets unique bytes.

```ts
const PNG_1X1_BLACK = 'iVBORw0KGgo...';   // test #1
const PNG_1X1_RED   = 'iVBORw0KGgo...';   // test #2
const PNG_1X1_BLUE  = 'iVBORw0KGgo...';   // test #3
const PNG_1X1_GREEN = 'iVBORw0KGgo...';   // test #4 (cellB in per-cell test)
```

Add a new color when you add a test that uploads. Generate via:

```bash
node -e "import('sharp').then(({default:sharp}) => \
  sharp({create:{width:1,height:1,channels:3,background:{r:128,g:128,b:128}}}) \
  .png().toBuffer().then(b=>console.log(b.toString('base64'))))"
```

Slugs follow the same logic: `e2e-rotate-${Date.now()}` everywhere. Two specs that picked the same slug literal would race on `posts.slug` uniqueness in SQLite.

---

## 4. Driving paths the UI doesn't expose

Some editor flows can't be driven through the UI alone:

- **Multi-image figure construction**: `Gallery` button uses a transient `<input type="file" multiple>` Playwright can't target by selector.
- **Programmatic node manipulation**: deleting a figure at a known position, calling `chain().updateAttributes(...)`, etc.

We expose `window.__rkrEditor` only when the URL is `/admin/editor?e2e=1`:

```ts
// src/admin/main.ts
if (new URLSearchParams(location.search).get('e2e') === '1') {
  (window as unknown as { __rkrEditor?: Editor }).__rkrEditor = editor;
}
```

Specs use it via `page.evaluate`:

```ts
await page.goto('/admin/editor?e2e=1');
// ...two single-image figures inserted via the file input above ...
await page.evaluate(({ a, b }) => {
  const ed = (window as unknown as { __rkrEditor?: import('@tiptap/core').Editor }).__rkrEditor;
  if (!ed) throw new Error('window.__rkrEditor not exposed; ?e2e=1 missing');
  // delete fig 2, merge ids into fig 1
  // ...
}, { a: idA, b: idB });
```

**Rule**: if you're tempted to add a NEW debug surface, prefer extending `__rkrEditor`'s context (it's a TipTap Editor, you have full editor commands available) over inventing a new global. Any debug API has to be query-string-gated like this one — it's never on in production.

---

## 5. The local server: rate limits and shared state

`test-e2e/server-runner.ts` builds the app with a few production-relaxing tweaks:

```ts
auth: { secureCookies: false, tokenLoginRateMax: 100 }
```

- `secureCookies: false` because the test server is HTTP, not HTTPS.
- `tokenLoginRateMax: 100` because production's 5/5-min cap trips when a multi-spec run logs in once per spec. Don't lower this.

`reuseExistingServer: !process.env.CI` (in `playwright.config.ts`) means a local re-run reuses the previous server **including its rate-limit state**. If a test fails with a 429 you didn't expect, the cause is probably "you ran the suite five times in five minutes." Either wait or `CI=1 npm run test:e2e` to force a fresh server.

Other production protections that can trip e2e if you're not careful:

| Protection | Where | Impact |
|---|---|---|
| /img/:filename rate limit (120/min) | `src/routes/public.ts` | The walk script (`scripts/walk-site.sh`) hits this on a content-rich seed; e2e is unlikely to. |
| Bake ops-hash header required | `src/routes/admin-sidecar-edit.ts` | Don't POST to `/admin/sidecar/:id/bake` from a test without computing `sha256(canonicalJson(ops))`. |
| Token-login rate cap | `src/routes/auth.ts` | Already mitigated above. |

---

## 6. Login + waitForURL idiom

Always go through the same login helper:

```ts
async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL('**/admin/editor'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
  await expect(page.locator('#rkroll-admin-root')).toBeVisible();
}
```

Two non-obvious things:

- **`Promise.all([waitForURL, click])`**: the click triggers navigation. Wrapping both in `Promise.all` lets Playwright register the navigation listener BEFORE the click fires, avoiding a race where the navigation completes before we start waiting for it.
- **The visibility check at the end** is the post-load assertion that proves we landed on the SPA, not on the login page with an error toast.

`ADMIN_TOKEN` is a shared constant — see existing specs.

---

## 7. Adding a new spec

```ts
// test-e2e/my-new-flow.spec.ts
import { expect, test } from './coverage-fixtures.ts';

const PNG_1X1_PURPLE = 'iVBORw0KGgo...';   // unique to this spec

test('my new flow does X', async ({ page }) => {
  await login(page);   // import or paste the helper
  // ...
});
```

Things to wire on day one:

1. Import `test` + `expect` from `./coverage-fixtures.ts` (not `@playwright/test`). Without this the spec runs but contributes nothing to coverage.
2. Generate a unique PNG. Reuse one of the existing colors only if your spec doesn't save edits to the sidecar (so it can tolerate prior state).
3. Pick a slug pattern: `e2e-<name>-${Date.now()}`.
4. If the flow needs editor manipulation Playwright can't reach, navigate to `/admin/editor?e2e=1` and use `window.__rkrEditor`.

---

## 8. Coverage capture — how it works

The fixture in `coverage-fixtures.ts` wraps Playwright's `page` fixture:

```ts
async (page, use) => {
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  try {
    await use(page);
  } finally {
    const data = await page.coverage.stopJSCoverage();
    if (data.length > 0) await mcr.add(data);
  }
}
```

Two design notes:

- **`resetOnNavigation: false`** — keep accumulating across navigations within a test. Login → editor → save all count toward the same data set.
- **Skip empty data**. Tests that never load any of our scripts (`wrong token does not establish a session` only hits `/admin/login`) return `[]`, and `mcr.add` rejects empty arrays. The skip prevents a teardown error.

`global-teardown.ts` calls `mcr.generate()` once at the end of the run; the report lands at `coverage/e2e/index.html` (HTML) and `coverage/e2e/lcov.info` (lcov for the ratchet).

Source-map resolution maps the bundled URLs (`/static/admin/main.js`) back to source paths (`src/admin/main.ts`). `entryFilter` + `sourceFilter` in the fixture limit the report to OUR code — without them, every TipTap / ProseMirror / PhotoSwipe file appears.

---

## 9. Debugging a failing spec

```bash
npm run test:e2e -- --headed --slow-mo=200            # watch in real time
npm run test:e2e -- --debug                            # opens the inspector
npx playwright show-trace test-results/<dir>/trace.zip # post-mortem on a failure
```

A failing test drops a `test-results/<spec>-<test>-chromium/` directory with `error-context.md` (Playwright's auto-generated explanation), `trace.zip`, optionally screenshots. **Always read `error-context.md` first** — it usually identifies the failing assertion and the page state at that moment.

For coverage debugging: `coverage/e2e/index.html` shows per-file uncovered lines. Click into a file to see which lines weren't hit.

---

## 10. The pre-commit ratchet (you already have it)

`.githooks/pre-commit` runs the e2e suite + coverage gate **only when `src/admin/**` or `src/site/**` is staged**. Three rules per file:

- **New file**: must be exercised at ≥ 75% lines.
- **Existing file at ≥ 75%**: must stay there.
- **Existing file below 75%**: uncovered-line count must not increase.

Output on failure:

```
e2e coverage ratchet failed:
  src/admin/main.ts: more uncovered lines than baseline: 26 → 31 (76.15% → 71.56%)

Add e2e coverage for the affected lines, or revisit the change.
```

Two paths to passing:

1. Add an e2e spec that exercises the new lines. (The right answer for new behavior.)
2. Make the change without adding net-uncovered lines (refactor only, change deletes lines, etc.).

`coverage-baseline.json` updates automatically on every passing commit, so improvements ratchet forward without manual bookkeeping.

### Carve-outs: code Playwright structurally can't see

`scripts/check-e2e-coverage.ts` keeps a small `EXEMPT` set of files
that bypass the new-file rule because the e2e harness cannot
instrument them. Today that's the service worker (`src/site/sw.ts`,
`src/site/sw-core.ts`) — Playwright's `page.coverage` only sees the
page's JS context, not the SW thread. These files are unit-tested in
Node via `test/site/sw-core.test.ts` with a Map-backed mock
`CacheStorage`, and that suite is enforced by the c8 per-file gate
in `npm run test:coverage` (≥ 90% lines / ≥ 75% branches).

When you add code that's structurally invisible to e2e (web workers,
SharedWorker, AudioWorklet, etc.), add the source file to `EXEMPT`
and pair it with a unit test under `test/site/`. Don't game the gate
for code that *is* reachable from a page — add an e2e spec instead.

---

## 11. Common gotchas (cheat sheet)

| Symptom | Likely cause | Fix |
|---|---|---|
| Test fails with a 429 from `/admin/auth/token-login` | Multiple test runs in 5 min hit the rate limit | `CI=1 npm run test:e2e` for a fresh server, or wait |
| Test fails with "post already exists" on save | Slug literal reused | `${Date.now()}` suffix |
| Image-edit panel snapshots show unexpected ops | Shared sidecar from a prior test using the same PNG bytes | Generate a unique PNG color |
| `window.__rkrEditor` is undefined | Loaded `/admin/editor` without `?e2e=1` | Add the query string |
| Coverage report shows lots of node_modules | `entryFilter` / `sourceFilter` too loose | Tighten in `coverage-fixtures.ts` |
| Bake POST returns 409 | Stale ops-hash | Re-fetch ops, recompute `sha256(canonicalJson(ops))`, retry |
| Selector for a button or input doesn't exist | Bundle wasn't rebuilt after a template/SPA change | `npm run build:admin && npm run build:site` |
| Spec adds 200 lines and the ratchet still passes | Coverage came in via existing flows | Good — but also confirm the new behavior is actually exercised, not just walked over |
| Test passes locally, fails in CI | Likely server reuse vs. fresh boot diff. Try `CI=1` locally. |

---

## What's deliberately NOT here

- A list of all our routes or DOM ids — those are in the templates and code; grep them.
- A general intro to Playwright. The upstream docs are good. Read them first if you're new.
- A page-object-model layer. We've stayed small enough that ad-hoc helper functions per spec are clearer than a framework.

If you find yourself adding a fourth `login(page)` helper, **promote it** to a shared `test-e2e/helpers.ts`. Keep the doc updated.
