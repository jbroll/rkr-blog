# Admin Shell Offline Launch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the installed admin PWA launch with no network, and let a pinned or locally-created post be viewed offline in its published form at `/admin/view/:slug`.

**Architecture:** Move every asset the admin shell needs under `/admin/static/` so the `/admin/`-scoped service worker can intercept it, precache that list keyed by the build hash, and serve the shell network-first / assets cache-first. Separately, make the markdown→HTML renderer pure by passing it a prebuilt map of image facts (`ImageMap`) instead of a `siteRoot` it reads from, so the same renderer runs in the browser against OPFS.

**Tech Stack:** TypeScript (ESM, `--experimental-strip-types`), Fastify + `@fastify/static`, esbuild, `node --test`, remark/mdast, sharp (server only), OPFS.

## Global Constraints

- Node `>=22`. Production source under `src/` and `bin/` is capped at **500 lines per file**; tests are exempt.
- The pre-commit gauntlet must pass: biome / tsc (all tsconfigs) / duplicate-types / no-reexports / knip:gate / circular / size / c8 coverage (`--lines=90 --branches=75 --functions=90`, per-file, `src/admin/**` excluded from coverage). Do not use `--no-verify`.
- ES modules, kebab-case filenames, no top-level side effects, `.ts` extensions on relative imports.
- Anything reachable from `src/admin/**` or `src/site/**` must not import `node:fs`, `node:crypto`, `node:path`, or `sharp` — directly or transitively. `tsconfig.browser.json` covers those trees.
- c8 counts only files a test actually loads (no `--all`), and holds each to 90% lines / 75% branches **per file**. Any new `src/**` module a test imports must be covered to that bar in the same commit.
- New files that are entry points (not imported by `src/server.ts`) must be added to the `knip.workspaces["."].entry` array in `package.json`, or `knip:gate` fails.
- Deferred work goes in `docs/DEFERRED.md`, one line, grouped by area, with `_revisit when:_ <trigger>`.
- Comments: say **why**, never what. Default to none. One or two lines.
- Cache name prefix is `rkr-admin-`; the build hash is `resolveGitHash().slice(0, 12)` everywhere.
- Static URL prefix for the admin shell is exactly `/admin/static/` (trailing slash), serving the same on-disk `staticDir` as `/static/`.

---

## Working branch

Before Task 1:

```bash
git checkout -b offline-admin-shell
```

All tasks commit onto that branch.

---

## File Structure

**New**

| File | Responsibility |
|---|---|
| `src/lib/site-assets.ts` | Server-side `AssetCtx` factory: reads `themeName()` + `resolveGitHash()`, returns `{theme, hash, base}`. The only place those two are called for templates. |
| `src/lib/image-map.ts` | Pure types: `ImageSource`, `ImageMap`. Imported by both halves and by the renderer. No runtime imports. |
| `src/lib/image-map-fs.ts` | Server prepass. Scans a post body for image ids, reads sidecars, resolves on-disk dimensions (owns `imageDimensions` / `ensureBake` / `applyOpsWithPerspective`, moved out of `widget-helpers.ts`), builds `/img/<id>.<oph>.<fmt>` URLs. |
| `src/site/sw-admin-core.ts` | Pure service-worker logic: `precacheInstall`, `evictOldCaches`, `handleFetch`. Takes `CacheStorage` + `fetch` as parameters so it is unit-testable in Node. |
| `scripts/gen-precache.ts` | Walks build output, writes `static/admin/precache.json`. |
| `src/admin/site-snapshot.ts` | Reads site title/tagline/theme/hash out of the server-rendered shell DOM and persists `opfs://meta/_site.json`; reads it back. |
| `src/admin/image-map-opfs.ts` | Client prepass. Same scan, sidecars + bytes from OPFS, `blob:` URLs. |
| `src/admin/preview-page.ts` | Boots `/admin/view/:slug`: OPFS content → markdown → mdast → `renderPostHtml` → `renderPostPage` → document. |
| `test/lib/site-assets.test.ts` | `serverAssets()` shape. |
| `test/lib/image-map-fs.test.ts` | Server prepass. |
| `test/site/sw-admin.test.ts` | Service worker unit tests. |
| `test/lib/image-map-equivalence.test.ts` | Both prepasses render one fixture identically. |
| `test/admin/image-map-opfs.test.ts` | Client prepass against the OPFS mock. |
| `test/admin/preview-page.test.ts` | Preview rendering. |

**Changed:** `src/templates/layout.ts`, `post.ts`, `index.ts`, `search.ts`, `not-found.ts`, `admin.ts`, `admin-settings.ts`, `admin-comments.ts`; `src/routes/public.ts`, `src/routes/admin.ts`, `src/server.ts`; `src/lib/content.ts`, `src/lib/widgets.ts`, `src/lib/widget-helpers.ts`; `src/widgets/figure.ts`; `src/site/sw-admin.ts`, `src/site/sw-admin-register.ts`; `src/admin/main.ts`, `src/admin/startup.ts`; `package.json`; docs.

---

## Task 1: Pure `layout.ts` — templates take an `AssetCtx`

`src/templates/layout.ts` calls `themeName()` and `resolveGitHash()`, which pull `node:fs` in through `lib/config.ts` and `lib/build-info.ts`. The preview page imports `templates/post.ts` → `layout.ts`, so those imports must go. Every template caller passes the values instead.

**Files:**
- Modify: `src/templates/layout.ts`
- Create: `src/lib/site-assets.ts`
- Modify: `src/templates/post.ts`, `src/templates/index.ts`, `src/templates/search.ts`, `src/templates/not-found.ts`, `src/templates/admin.ts`, `src/templates/admin-settings.ts`, `src/templates/admin-comments.ts`
- Modify: `src/routes/public.ts`, `src/routes/admin.ts`, `src/routes/admin-comments.ts`, `src/routes/admin-settings.ts`, `src/server.ts`
- Create: `test/lib/site-assets.test.ts`
- Modify: `test/templates/layout.test.ts` and any template/route test that constructs template data

**Model:** `sonnet` — mechanical but spread across ~15 files with existing tests to repair.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  // src/templates/layout.ts
  export interface AssetCtx { theme: string; hash: string; base: string }
  export function bundleVersion(a: AssetCtx): string
  export function headIcons(a: AssetCtx): string
  export function stylesheetLinks(a: AssetCtx): string
  export interface SiteChrome { site: { title: string; tagline?: string }; assets: AssetCtx }
  // src/lib/site-assets.ts
  export function serverAssets(base?: string): AssetCtx
  ```

- [ ] **Step 1: Write the failing test**

Create `test/lib/site-assets.test.ts`:

```ts
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { _resetGitHashCache } from '../../src/lib/build-info.ts';
import { _resetThemeNameCache } from '../../src/lib/config.ts';
import { serverAssets } from '../../src/lib/site-assets.ts';

afterEach(() => {
  _resetGitHashCache();
  _resetThemeNameCache();
});

test('serverAssets: hash is the 12-char git short hash, base defaults to /static', () => {
  const prev = process.env.GIT_HASH;
  process.env.GIT_HASH = 'abcdef0123456789abcdef0123456789abcdef01';
  try {
    const a = serverAssets();
    assert.equal(a.hash, 'abcdef012345');
    assert.equal(a.base, '/static');
    assert.equal(typeof a.theme, 'string');
  } finally {
    if (prev === undefined) delete process.env.GIT_HASH;
    else process.env.GIT_HASH = prev;
  }
});

test('serverAssets: base is overridable for the admin shell', () => {
  assert.equal(serverAssets('/admin/static').base, '/admin/static');
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --test-name-pattern='serverAssets'`
Expected: FAIL — `Cannot find module .../src/lib/site-assets.ts`.

- [ ] **Step 3: Rewrite `layout.ts` to be pure**

In `src/templates/layout.ts`, delete these two imports:

```ts
import { resolveGitHash } from '../lib/build-info.ts';
import { themeName } from '../lib/config.ts';
```

Replace `bundleVersion`, `headIcons`, `stylesheetLinks`, and `SiteChrome` with:

```ts
/** Everything a template needs to build an asset URL: the active
 * theme, the build hash used as the ?v= cache-buster, and the URL
 * prefix the assets are served from ('/static' publicly,
 * '/admin/static' inside the admin service worker's scope). */
export interface AssetCtx {
  theme: string;
  hash: string;
  base: string;
}

export function bundleVersion(a: AssetCtx): string {
  return `?v=${a.hash}`;
}

export function headIcons(a: AssetCtx): string {
  const v = bundleVersion(a);
  return `<link rel="icon" type="image/x-icon" href="${a.base}/favicon.ico${v}"/>
<link rel="icon" type="image/png" sizes="32x32" href="${a.base}/icon-32.png${v}"/>
<link rel="apple-touch-icon" sizes="180x180" href="${a.base}/apple-touch-icon.png${v}"/>`;
}

export function stylesheetLinks(a: AssetCtx): string {
  const v = bundleVersion(a);
  const base = `<meta name="color-scheme" content="light dark"/>
<link rel="stylesheet" href="${a.base}/base.css${v}"/>
<link rel="stylesheet" href="${a.base}/themes/default.css${v}"/>`;
  if (a.theme === 'default') return base;
  return `${base}
<link rel="stylesheet" href="${a.base}/themes/${a.theme}.css${v}"/>`;
}

export interface SiteChrome {
  /** Resolved site config — owner-side branding only; never per-request. */
  site: { title: string; tagline?: string };
  assets: AssetCtx;
}
```

Keep the existing doc-comment above `stylesheetLinks` (the cascade-order explanation), and keep `siteHead`, `siteFoot`, `renderSearchForm`, `indexAdminFabs`, `postAdminFab` unchanged. The `?v=` suffix is now on the icons too — that is deliberate, the precache manifest in Task 3 relies on every cached URL carrying it.

- [ ] **Step 4: Add `src/lib/site-assets.ts`**

```ts
// Resolves the AssetCtx templates need. The only place themeName() +
// resolveGitHash() are read for rendering, so templates stay pure and
// bundle into the admin build.

import { resolveGitHash } from './build-info.ts';
import { themeName } from './config.ts';
import type { AssetCtx } from '../templates/layout.ts';

export function serverAssets(base = '/static'): AssetCtx {
  return { theme: themeName(), hash: resolveGitHash().slice(0, 12), base };
}
```

- [ ] **Step 5: Thread `assets` through every template**

In each of `post.ts`, `index.ts`, `search.ts`, `not-found.ts`, `admin.ts`, `admin-settings.ts`, `admin-comments.ts`:
- the page-data interface already extends `SiteChrome` (check each; `admin-settings.ts` and `admin-comments.ts` may declare their own `site` field — make them extend `SiteChrome` instead), so `data.assets` is available;
- replace `bundleVersion()` → `bundleVersion(data.assets)`, `stylesheetLinks()` → `stylesheetLinks(data.assets)`, `headIcons()` → `headIcons(data.assets)`;
- replace every hard-coded `/static/` in a `src=`/`href=` inside those templates with `${data.assets.base}/` — e.g. in `post.ts`:

```ts
const a = post.assets;
const v = bundleVersion(a);
// …
<link rel="stylesheet" href="${a.base}/site/lightbox.css${v}"/>
<script type="module" src="${a.base}/site/img-retry.js${v}" defer></script>
```

(`sw-unregister.js` in `post.ts`, `index.ts`, `search.ts`, `not-found.ts` keeps the same treatment; it stays on public pages.)

- [ ] **Step 6: Add `scripts` opt-out to `renderPostPage`**

The preview reuses `renderPostPage` but must not load the public-page scripts (they are outside the service worker's precache and pointless in a static preview). In `src/templates/post.ts` add to `PostPageData`:

```ts
  /** When false, omit the public-page <script> tags. The offline
   * preview renders a static document. Default true. */
  scripts?: boolean;
```

and wrap the six `<script type="module" …>` lines in the head:

```ts
  const scriptTags =
    post.scripts === false
      ? ''
      : `<script type="module" src="${a.base}/site/sw-unregister.js${v}" defer></script>
<script type="module" src="${a.base}/site/img-retry.js${v}" defer></script>
<script type="module" src="${a.base}/site/lightbox.js${v}" defer></script>
<script type="module" src="${a.base}/site/carousel.js${v}" defer></script>
<script type="module" src="${a.base}/site/copy-link.js${v}" defer></script>
<script type="module" src="${a.base}/site/comment-form.js${v}" defer></script>`;
```

interpolating `${scriptTags}` where those lines were.

- [ ] **Step 7: Pass `assets` from every route**

In `src/routes/public.ts`, `src/routes/admin.ts`, `src/routes/admin-comments.ts`, `src/routes/admin-settings.ts`, and `src/server.ts`, import `serverAssets` and add `assets: serverAssets()` to each `render*Page({...})` call. Resolve it per request (not once at registration) — the settings page can change the theme at runtime, and `themeName()` re-reads after its cache reset.

`src/routes/admin.ts`'s `renderAdminPage` call uses `assets: serverAssets('/admin/static')` — that prefix lands in Task 2, and serving it lands there too, so for **this** task use `serverAssets()` in `admin.ts` and switch it in Task 2.

- [ ] **Step 8: Sever `templates/post.ts` from `lib/comments.ts`**

The preview imports `templates/post.ts`, which imports `countThread` and `type ThreadComment` from `src/lib/comments.ts`, which type-imports `Db` from `src/lib/db.ts`. A type-only import still puts `db.ts` in the browser program, and `tsc -p tsconfig.browser.json` then fails on `node:sqlite` (verified). Move the two pure pieces out:

Create `src/lib/comment-types.ts`:

```ts
// Comment shapes the templates render. Separate from lib/comments.ts
// so a browser-side renderer doesn't pull db.ts into its type program.

export type CommentStatus = 'pending' | 'published' | 'queued' | 'rejected';

export interface ThreadComment {
  /* copy the field list verbatim from lib/comments.ts's ThreadComment */
}

export function countThread(thread: ThreadComment[]): number {
  return thread.reduce((n, c) => n + 1 + c.replies.length, 0);
}
```

Copy `ThreadComment`'s field list exactly as it stands in `src/lib/comments.ts`, delete the original declaration and `countThread` there, and have `lib/comments.ts` import them from `./comment-types.ts`. Re-exporting is forbidden by the `no-reexports` gate, so update every importer to point at the new module: `src/templates/comments.ts`, `src/templates/post.ts`, `test/templates/comments.test.ts`, `test/templates/post.test.ts`, `test/lib/comments.test.ts`. If `CommentStatus` is only used by `lib/comments.ts` and its callers, leave it where it is — move it only if `ThreadComment` references it.

- [ ] **Step 9: Prove the templates are browser-safe**

```bash
cat > src/admin/__probe.ts <<'EOF'
import { renderPostPage } from '../templates/post.ts';
export const x = typeof renderPostPage;
EOF
npx tsc -p tsconfig.browser.json --noEmit; rm src/admin/__probe.ts
```

Expected: no output. Any `Cannot find name 'node:…'` error names the module that still leaks — chase the import chain from `templates/post.ts` and cut it. (Before this task the probe reports errors from `config.ts`, `build-info.ts`, `atomic-write.ts`, and `db.ts`; all four must be gone.)

- [ ] **Step 10: Repair the existing tests**

`test/templates/layout.test.ts` and the template/route tests construct page data. Give each a fixture:

```ts
const assets = { theme: 'default', hash: 'abcdef012345', base: '/static' };
```

and pass it (`bundleVersion(assets)`, `stylesheetLinks({...assets, theme: 'tufte'})`, `renderNotFoundPage({ site, assets })`, …). The two `bundleVersion` tests that manipulate `process.env.GIT_HASH` now belong to `serverAssets` — move their assertions to `test/lib/site-assets.test.ts` (Step 1 already covers the first; delete the now-meaningless "stable per process" one, since `bundleVersion` is a pure function of its argument).

- [ ] **Step 11: Run the full gauntlet**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS. Fix every remaining call-site the compiler flags — `tsc` finds them all, since `AssetCtx` is a required field.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "refactor(templates): pass an AssetCtx instead of reading theme/hash in layout.ts"
```

---

## Task 2: Serve and reference the shell's assets under `/admin/static/`

A service worker only intercepts fetches inside its scope. The shell's assets must therefore live under `/admin/`.

**Files:**
- Modify: `src/routes/admin.ts:88-106` (the `fastify-static` registration), `src/routes/admin.ts:108-126` (the `/admin/editor` handler)
- Modify: `src/templates/admin.ts:36-46`
- Modify: `src/site/sw-admin-register.ts`
- Modify: `test/templates/admin-pwa.test.ts`
- Modify: `test/routes/admin.test.ts` (add the integration assertions)

**Model:** `sonnet` — small but touches routing, headers, and CSP-adjacent code.

**Interfaces:**
- Consumes: `AssetCtx`, `serverAssets(base)` from Task 1.
- Produces: `/admin/static/**` serving the same bytes as `/static/**`; the admin shell's HTML references only `/admin/static/...`.

- [ ] **Step 1: Write the failing tests**

Append to `test/routes/admin.test.ts` (follow the file's existing app-building helper — reuse whatever `buildApp`/`freshSiteRoot` fixture the file already defines):

```ts
test('/admin/static and /static serve identical bytes', async (t) => {
  const app = await makeApp(t); // existing helper in this file
  const viaAdmin = await app.inject({ method: 'GET', url: '/admin/static/base.css' });
  const viaPublic = await app.inject({ method: 'GET', url: '/static/base.css' });
  assert.equal(viaAdmin.statusCode, 200);
  assert.equal(viaAdmin.body, viaPublic.body);
});

test('/admin/editor references only /admin/static assets', async (t) => {
  const app = await makeApp(t);
  const res = await app.inject({ method: 'GET', url: '/admin/editor' });
  assert.equal(res.statusCode, 200);
  const srcs = [...res.body.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1] as string);
  const staticRefs = srcs.filter((u) => u.startsWith('/static/'));
  assert.deepEqual(staticRefs, [], `unexpected /static refs: ${staticRefs.join(', ')}`);
});

test('sw-admin.js under /admin/static carries Service-Worker-Allowed', async (t) => {
  const app = await makeApp(t);
  const res = await app.inject({ method: 'GET', url: '/admin/static/site/sw-admin.js' });
  assert.equal(res.headers['service-worker-allowed'], '/admin/');
});
```

The third test needs `static/site/sw-admin.js` to exist on disk; run `npm run build:site` first if the file is absent, or point the test at the repo's real `static/` dir the way the file's other tests do.

- [ ] **Step 2: Run them to confirm they fail**

Run: `npm test -- --test-name-pattern='/admin/static'`
Expected: FAIL — 404 for `/admin/static/base.css`.

- [ ] **Step 3: Register the second static handler**

In `src/routes/admin.ts`, extract the shared `setHeaders` and register twice:

```ts
  // Service-Worker-Allowed lets sw-admin.js claim scope `/admin/`
  // rather than only the directory it is served from.
  const setHeaders = (res: ServerResponse, filepath: string): void => {
    if (filepath.endsWith(`${path.sep}site${path.sep}sw-admin.js`)) {
      res.setHeader('Service-Worker-Allowed', '/admin/');
    }
  };

  if (fs.existsSync(staticDir)) {
    await fastify.register(fastifyStatic, {
      root: staticDir,
      prefix: '/static/',
      decorateReply: false,
      setHeaders
    });
    // Same bytes, second mount: a service worker scoped to /admin/
    // never sees a fetch for /static/*, so the shell's assets have to
    // be reachable inside the scope.
    await fastify.register(fastifyStatic, {
      root: staticDir,
      prefix: '/admin/static/',
      decorateReply: false,
      setHeaders
    });
  }
```

Import the type: `import type { ServerResponse } from 'node:http';`

- [ ] **Step 4: Point the shell at `/admin/static`**

In `src/routes/admin.ts`'s `/admin/editor` handler:

```ts
        renderAdminPage({
          site: siteConfig(),
          assets: serverAssets('/admin/static'),
          bundleUrl: `/admin/static/admin/main.js?v=${resolveGitHash().slice(0, 12)}`,
          cspNonce: nonce
        })
```

In `src/templates/admin.ts`, replace the head block:

```ts
const a = data.assets;
const v = bundleVersion(a);
// …
${stylesheetLinks(a)}
${headIcons(a)}
<link rel="stylesheet" href="${a.base}/admin/main.css${v}"/>
<style nonce="${data.cspNonce}">
…
</style>
<link rel="manifest" href="${a.base}/admin-manifest.webmanifest${v}"/>
<script type="module" src="${a.base}/site/sw-admin-register.js${v}" defer></script>
```

- [ ] **Step 5: Register the worker from inside the scope**

`src/site/sw-admin-register.ts`:

```ts
    .register('/admin/static/site/sw-admin.js', { scope: '/admin/' })
```

Registering a different script URL at the same scope replaces the old registration, so installed clients migrate on their next online load.

- [ ] **Step 6: Update the manifest's icon URLs**

`static/admin-manifest.webmanifest` — the PWA manifest is fetched by the browser at `/admin/static/admin-manifest.webmanifest`; its icon `src` values resolve against it, so absolute `/static/icon-192.png` still works but is outside the SW scope. Change both to `/admin/static/icon-192.png` and `/admin/static/icon-512.png`.

- [ ] **Step 7: Fix `test/templates/admin-pwa.test.ts`**

Its `base` fixture needs `assets: { theme: 'default', hash: 'abcdef012345', base: '/admin/static' }`, and the two assertions become `/\/admin\/static\/admin-manifest\.webmanifest/` and unchanged for the register script.

- [ ] **Step 8: Run tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(admin): serve and reference the shell's assets under /admin/static/"
```

---

## Task 3: Build-generated precache manifest

`build:admin` runs esbuild with `--splitting`; chunk filenames are not knowable ahead of time, so the list is generated after the build.

**Files:**
- Create: `scripts/gen-precache.ts`
- Modify: `package.json` (`build:admin` script, `knip` entry list)
- Create: `test/scripts/gen-precache.test.ts`

**Model:** `sonnet` — a single file, but the URL/suffix contract has to match the templates exactly.

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // scripts/gen-precache.ts
  export interface Precache { hash: string; assets: string[] }
  export function buildPrecache(repoRoot: string, hash: string): Precache
  ```
  and, when run as a script, writes `static/admin/precache.json`.

- [ ] **Step 1: Write the failing test**

Create `test/scripts/gen-precache.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { buildPrecache } from '../../scripts/gen-precache.ts';

function fixtureRepo(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-precache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'static', 'admin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'static', 'themes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'static', 'site'), { recursive: true });
  fs.writeFileSync(path.join(root, 'static', 'admin', 'main.js'), '//');
  fs.writeFileSync(path.join(root, 'static', 'admin', 'main.js.map'), '{}');
  fs.writeFileSync(path.join(root, 'static', 'admin', 'main.css'), '/* */');
  fs.writeFileSync(path.join(root, 'static', 'admin', 'chunk-ABC123.js'), '//');
  for (const name of ['default', 'tufte', 'dracula']) {
    fs.writeFileSync(path.join(root, 'static', 'themes', `${name}.css`), '/* */');
  }
  fs.writeFileSync(path.join(root, 'static', 'base.css'), '/* */');
  fs.writeFileSync(path.join(root, 'static', 'admin-manifest.webmanifest'), '{}');
  fs.writeFileSync(path.join(root, 'static', 'favicon.ico'), '');
  fs.writeFileSync(path.join(root, 'static', 'icon-32.png'), '');
  fs.writeFileSync(path.join(root, 'static', 'apple-touch-icon.png'), '');
  fs.writeFileSync(path.join(root, 'static', 'site', 'sw-admin-register.js'), '//');
  fs.writeFileSync(path.join(root, 'static', 'site', 'lightbox.css'), '/* */');
  return root;
}

test('buildPrecache: lists every emitted file under static/admin, sourcemaps excluded', (t) => {
  const { assets } = buildPrecache(fixtureRepo(t), 'abcdef012345');
  assert.ok(assets.includes('/admin/static/admin/main.js?v=abcdef012345'));
  assert.ok(assets.includes('/admin/static/admin/chunk-ABC123.js?v=abcdef012345'));
  assert.ok(assets.includes('/admin/static/admin/main.css?v=abcdef012345'));
  assert.ok(!assets.some((a) => a.includes('.map')), 'sourcemaps excluded');
});

test('buildPrecache: every theme sheet is listed', (t) => {
  const { assets } = buildPrecache(fixtureRepo(t), 'abcdef012345');
  for (const name of ['default', 'tufte', 'dracula']) {
    assert.ok(
      assets.includes(`/admin/static/themes/${name}.css?v=abcdef012345`),
      `${name} missing`
    );
  }
});

test('buildPrecache: every entry carries the ?v= suffix and the /admin/static prefix', (t) => {
  const { assets, hash } = buildPrecache(fixtureRepo(t), 'abcdef012345');
  assert.equal(hash, 'abcdef012345');
  for (const a of assets) {
    assert.ok(a.startsWith('/admin/static/'), a);
    assert.ok(a.endsWith('?v=abcdef012345'), a);
  }
});

test('buildPrecache: fixed assets the shell references are listed', (t) => {
  const { assets } = buildPrecache(fixtureRepo(t), 'abcdef012345');
  for (const rel of [
    'base.css',
    'admin-manifest.webmanifest',
    'favicon.ico',
    'icon-32.png',
    'apple-touch-icon.png',
    'site/sw-admin-register.js',
    'site/lightbox.css'
  ]) {
    assert.ok(assets.includes(`/admin/static/${rel}?v=abcdef012345`), `${rel} missing`);
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --test-name-pattern='buildPrecache'`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `scripts/gen-precache.ts`**

```ts
// Writes static/admin/precache.json: the exact URL list the admin
// service worker installs into rkr-admin-<hash>. Generated because
// esbuild's --splitting chunk names aren't knowable ahead of the build.
//
// Every URL carries the ?v=<hash> suffix the templates stamp — cache
// keys include the query string, so an entry without it would never
// match the request the page actually makes.

import fs from 'node:fs';
import path from 'node:path';

import { resolveGitHash } from '../src/lib/build-info.ts';

export interface Precache {
  hash: string;
  assets: string[];
}

/** Files the shell references by a fixed name. Theme sheets and the
 * static/admin/* build output are enumerated from disk instead. */
const FIXED = [
  'base.css',
  'admin-manifest.webmanifest',
  'favicon.ico',
  'icon-32.png',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'site/sw-admin-register.js',
  'site/lightbox.css'
];

function walk(dir: string, rel: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(path.join(dir, entry.name), childRel, out);
    } else if (!entry.name.endsWith('.map') && entry.name !== 'precache.json') {
      out.push(childRel);
    }
  }
}

export function buildPrecache(repoRoot: string, hash: string): Precache {
  const staticDir = path.join(repoRoot, 'static');
  const rels: string[] = [];
  walk(path.join(staticDir, 'admin'), 'admin', rels);

  const themesDir = path.join(staticDir, 'themes');
  if (fs.existsSync(themesDir)) {
    for (const f of fs.readdirSync(themesDir)) {
      // The active theme is runtime config, so every sheet ships.
      if (f.endsWith('.css')) rels.push(`themes/${f}`);
    }
  }

  for (const f of FIXED) {
    if (fs.existsSync(path.join(staticDir, f))) rels.push(f);
  }

  rels.sort();
  return { hash, assets: rels.map((r) => `/admin/static/${r}?v=${hash}`) };
}

export function writePrecache(repoRoot: string, hash: string): string {
  const out = path.join(repoRoot, 'static', 'admin', 'precache.json');
  fs.writeFileSync(out, `${JSON.stringify(buildPrecache(repoRoot, hash), null, 2)}\n`, 'utf8');
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const out = writePrecache(repoRoot, resolveGitHash().slice(0, 12));
  process.stdout.write(`${out}\n`);
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- --test-name-pattern='buildPrecache'`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire it into the build**

In `package.json`, append to `build:admin` (keep the existing two esbuild invocations, add a third stage):

```
&& node --no-warnings=ExperimentalWarning --experimental-strip-types scripts/gen-precache.ts
```

Add `"scripts/gen-precache.ts"` to `knip.workspaces["."].entry`.

- [ ] **Step 6: Verify against a real build**

Run: `npm run build && cat static/admin/precache.json | head -20`
Expected: a `hash` field plus an `assets` array whose first entries are `/admin/static/admin/…?v=<hash>`; every emitted chunk in `static/admin/` present; no `.map`.

Then confirm the manifest agrees with what the shell actually requests:

Run: `npm run knip:gate && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "build(admin): emit static/admin/precache.json from the build output"
```

Note: `static/admin/` is build output — check whether it is gitignored (`git check-ignore -v static/admin/precache.json`). If it is, leave it ignored; the deploy runs `npm run build`.

---

## Task 4: The service worker

**Files:**
- Create: `src/site/sw-admin-core.ts`
- Modify: `src/site/sw-admin.ts`
- Create: `test/site/sw-admin.test.ts`
- Modify: `package.json` (`knip` entry: `src/site/sw-admin-core.ts` is imported by `sw-admin.ts`, so no entry needed — verify with `knip:gate`)

**Model:** `sonnet` — self-contained, fully specified below.

**Interfaces:**
- Consumes: `/admin/static/admin/precache.json` shape `{ hash: string; assets: string[] }` from Task 3.
- Produces:
  ```ts
  // src/site/sw-admin-core.ts
  export const CACHE_PREFIX = 'rkr-admin-';
  export const PRECACHE_URL = '/admin/static/admin/precache.json';
  export const SHELL_URL = '/admin/editor';
  export interface SwEnv { caches: CacheStorage; fetch: typeof fetch }
  export async function precacheInstall(env: SwEnv): Promise<string>
  export async function evictOldCaches(env: SwEnv, keep: string): Promise<string[]>
  export function handleFetch(env: SwEnv, req: Request): Promise<Response> | null
  ```

- [ ] **Step 1: Write the failing test**

Create `test/site/sw-admin.test.ts`. It fakes `CacheStorage` and `fetch`; no globals are touched, because the core takes both as parameters.

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CACHE_PREFIX,
  evictOldCaches,
  handleFetch,
  precacheInstall
} from '../../src/site/sw-admin-core.ts';

class FakeCache {
  entries = new Map<string, Response>();
  async addAll(urls: string[]): Promise<void> {
    for (const u of urls) this.entries.set(u, new Response(`body:${u}`));
  }
  async add(url: string): Promise<void> {
    this.entries.set(url, new Response(`body:${url}`));
  }
  async put(req: Request | string, res: Response): Promise<void> {
    this.entries.set(typeof req === 'string' ? req : req.url, res);
  }
  async match(req: Request | string, opts?: { ignoreSearch?: boolean }): Promise<Response | undefined> {
    const url = new URL(typeof req === 'string' ? req : req.url, 'https://x.test');
    for (const [k, v] of this.entries) {
      const kk = new URL(k, 'https://x.test');
      if (kk.pathname !== url.pathname) continue;
      if (opts?.ignoreSearch || kk.search === url.search) return v;
    }
    return undefined;
  }
}

class FakeCaches {
  store = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    let c = this.store.get(name);
    if (!c) {
      c = new FakeCache();
      this.store.set(name, c);
    }
    return c;
  }
  async keys(): Promise<string[]> {
    return [...this.store.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.store.delete(name);
  }
  async match(req: Request | string, opts?: { ignoreSearch?: boolean }): Promise<Response | undefined> {
    for (const c of this.store.values()) {
      const hit = await c.match(req, opts);
      if (hit) return hit;
    }
    return undefined;
  }
}

const PRECACHE = {
  hash: 'abcdef012345',
  assets: ['/admin/static/admin/main.js?v=abcdef012345', '/admin/static/base.css?v=abcdef012345']
};

function env(fetchImpl: typeof fetch): { caches: FakeCaches; fetch: typeof fetch } {
  return { caches: new FakeCaches(), fetch: fetchImpl };
}

const okPrecache: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('precache.json')) return new Response(JSON.stringify(PRECACHE));
  return new Response(`network:${url}`);
};

test('precacheInstall: caches every listed asset plus the shell, under rkr-admin-<hash>', async () => {
  const e = env(okPrecache) as never as Parameters<typeof precacheInstall>[0];
  const hash = await precacheInstall(e);
  assert.equal(hash, 'abcdef012345');
  const cache = await e.caches.open(`${CACHE_PREFIX}abcdef012345`);
  assert.ok(await cache.match('/admin/static/admin/main.js?v=abcdef012345'));
  assert.ok(await cache.match('/admin/editor'));
});

test('evictOldCaches: deletes foreign hashes, keeps the current one', async () => {
  const e = env(okPrecache) as never as Parameters<typeof evictOldCaches>[0];
  await e.caches.open(`${CACHE_PREFIX}old111111111`);
  await e.caches.open(`${CACHE_PREFIX}abcdef012345`);
  await e.caches.open('some-other-cache');
  const deleted = await evictOldCaches(e, 'abcdef012345');
  assert.deepEqual(deleted, [`${CACHE_PREFIX}old111111111`]);
  assert.deepEqual((await e.caches.keys()).sort(), [
    `${CACHE_PREFIX}abcdef012345`,
    'some-other-cache'
  ]);
});

test('navigation: prefers the network when fetch resolves', async () => {
  const e = env(okPrecache) as never as Parameters<typeof precacheInstall>[0];
  await precacheInstall(e);
  const res = await handleFetch(e, new Request('https://x.test/admin/editor', { mode: 'navigate' }));
  assert.equal(await (res as Response).text(), 'network:https://x.test/admin/editor');
});

test('navigation: falls back to the cached shell when fetch rejects', async () => {
  const e = env(okPrecache) as never as Parameters<typeof precacheInstall>[0];
  await precacheInstall(e);
  const offline = { ...e, fetch: (async () => { throw new Error('offline'); }) as typeof fetch };
  const res = await handleFetch(offline, new Request('https://x.test/admin/editor?slug=a', { mode: 'navigate' }));
  assert.equal(await (res as Response).text(), 'body:/admin/editor');
});

test('navigation: /admin/view/<slug> falls back to the same cached shell', async () => {
  const e = env(okPrecache) as never as Parameters<typeof precacheInstall>[0];
  await precacheInstall(e);
  const offline = { ...e, fetch: (async () => { throw new Error('offline'); }) as typeof fetch };
  const res = await handleFetch(offline, new Request('https://x.test/admin/view/hello', { mode: 'navigate' }));
  assert.equal(await (res as Response).text(), 'body:/admin/editor');
});

test('/admin/static/*: served from cache with no network call on a hit', async () => {
  const e = env(okPrecache) as never as Parameters<typeof precacheInstall>[0];
  await precacheInstall(e);
  let calls = 0;
  const counting = {
    ...e,
    fetch: (async (...args: Parameters<typeof fetch>) => {
      calls++;
      return okPrecache(...args);
    }) as typeof fetch
  };
  const res = await handleFetch(
    counting,
    new Request('https://x.test/admin/static/base.css?v=abcdef012345')
  );
  assert.equal(await (res as Response).text(), 'body:/admin/static/base.css?v=abcdef012345');
  assert.equal(calls, 0);
});

test('/admin/api/* is not intercepted', () => {
  const e = env(okPrecache) as never as Parameters<typeof precacheInstall>[0];
  assert.equal(handleFetch(e, new Request('https://x.test/admin/sync/drain')), null);
  assert.equal(handleFetch(e, new Request('https://x.test/admin/post-bundle/x?manifest=1')), null);
});

test('/admin/static/*: a cache miss falls through to the network', async () => {
  const e = env(okPrecache) as never as Parameters<typeof precacheInstall>[0];
  const res = await handleFetch(e, new Request('https://x.test/admin/static/nope.css'));
  assert.equal(await (res as Response).text(), 'network:https://x.test/admin/static/nope.css');
});

test('navigation: offline with nothing cached yields 503, not a throw', async () => {
  const offline = {
    ...(env(okPrecache) as never as Parameters<typeof precacheInstall>[0]),
    fetch: (async () => {
      throw new Error('offline');
    }) as typeof fetch
  };
  const res = await handleFetch(offline, new Request('https://x.test/admin/editor', { mode: 'navigate' }));
  assert.equal((res as Response).status, 503);
});

test('a POST under /admin/ is never intercepted', () => {
  const e = env(okPrecache) as never as Parameters<typeof precacheInstall>[0];
  assert.equal(
    handleFetch(e, new Request('https://x.test/admin/static/base.css', { method: 'POST' })),
    null
  );
});
```

These last three exist for the coverage gate as much as for the behavior: `src/site/sw-admin-core.ts` is loaded by this test file, so c8 holds it to the per-file 90% lines / 75% branches threshold, and the `?? new Response(503)` and `?? env.fetch(req)` branches are the ones that go uncovered otherwise. (`src/site/sw-admin.ts` is never imported by a test, so c8 does not count it — the project runs without `--all`.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --test-name-pattern='precacheInstall'`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/site/sw-admin-core.ts`**

```ts
// Admin PWA cache logic, kept out of sw-admin.ts so it can be unit
// tested in Node: CacheStorage and fetch arrive as parameters rather
// than off `self`.
//
// One cache per build hash means new HTML can never pair with old
// chunks — the drift that kept the shell uncached before.

export const CACHE_PREFIX = 'rkr-admin-';
export const PRECACHE_URL = '/admin/static/admin/precache.json';
export const SHELL_URL = '/admin/editor';

export interface SwEnv {
  caches: CacheStorage;
  fetch: typeof fetch;
}

interface Precache {
  hash: string;
  assets: string[];
}

export async function precacheInstall(env: SwEnv): Promise<string> {
  const res = await env.fetch(PRECACHE_URL, { cache: 'no-store' });
  const manifest = (await res.json()) as Precache;
  const cache = await env.caches.open(CACHE_PREFIX + manifest.hash);
  await cache.addAll(manifest.assets);
  // The shell is a server render, not a build artifact, so it isn't in
  // the manifest; one cached copy serves every /admin/view/* slug too.
  await cache.add(SHELL_URL);
  return manifest.hash;
}

export async function evictOldCaches(env: SwEnv, keep: string): Promise<string[]> {
  const current = CACHE_PREFIX + keep;
  const stale = (await env.caches.keys()).filter(
    (name) => name.startsWith(CACHE_PREFIX) && name !== current
  );
  for (const name of stale) await env.caches.delete(name);
  return stale;
}

function isShellNavigation(url: URL, req: Request): boolean {
  if (req.mode !== 'navigate') return false;
  return url.pathname === SHELL_URL || url.pathname.startsWith('/admin/view/');
}

/** Returns the response promise to serve, or null to let the request
 * go to the network untouched (/admin/api, /admin/sync, /admin/post-bundle
 * and friends — the outbox already owns their offline behavior). */
export function handleFetch(env: SwEnv, req: Request): Promise<Response> | null {
  const url = new URL(req.url);
  if (req.method !== 'GET') return null;

  if (isShellNavigation(url, req)) {
    // Network-first: online the author always gets the fresh server
    // render, so a stale bundle survives at most one launch.
    return env
      .fetch(req)
      .catch(() => env.caches.match(SHELL_URL, { ignoreSearch: true }))
      .then((res) => res ?? new Response('offline', { status: 503 }));
  }

  if (url.pathname.startsWith('/admin/static/')) {
    // Immutable for a given hash, so a hit is always correct.
    return env.caches
      .match(req)
      .then((hit) => hit ?? env.fetch(req));
  }

  return null;
}
```

- [ ] **Step 4: Rewrite `src/site/sw-admin.ts`**

```ts
// Admin PWA service worker. Precaches the shell + its assets into a
// cache keyed by the build hash so the installed app launches with no
// network (docs/spec-offline.md §3).

import { evictOldCaches, handleFetch, precacheInstall, type SwEnv } from './sw-admin-core.ts';

const sw = self as unknown as ServiceWorkerGlobalScope;
const env: SwEnv = { caches: sw.caches, fetch: (...args) => sw.fetch(...args) };

sw.addEventListener('install', (e) => {
  e.waitUntil(precacheInstall(env).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    precacheInstall(env)
      .then((hash) => evictOldCaches(env, hash))
      .then(() => sw.clients.claim())
  );
});

sw.addEventListener('fetch', (e) => {
  const res = handleFetch(env, e.request);
  if (res) e.respondWith(res);
});
```

`activate` re-reads `precache.json` rather than carrying the hash across events — a service worker's global scope can be torn down between `install` and `activate`, and the fetch is a cache hit by then.

- [ ] **Step 5: Run the tests**

Run: `npm test -- --test-name-pattern='sw-admin|precacheInstall|evictOldCaches|navigation|/admin/'`
Expected: PASS (10 tests).

- [ ] **Step 6: Verify the built worker is a single file**

Run: `npm run build:site && grep -c '^import' static/site/sw-admin.js || true`
Expected: `0` — esbuild inlines `sw-admin-core.ts` because nothing else imports it. If a shared chunk appears (a `from "./chunk-*.js"` in the output), add a dedicated non-splitting esbuild invocation for `src/site/sw-admin.ts` in `build:site`, mirroring how `opfs-worker.ts` is built separately in `build:admin`.

- [ ] **Step 7: Run the gauntlet and commit**

Run: `npm run typecheck && npm run lint && npm test`

```bash
git add -A
git commit -m "feat(sw): precache the admin shell, keyed by build hash"
```

---

## Task 5: Server-side image prepass

Gather every image fact before rendering, so the renderer itself can become pure in Task 6.

**Files:**
- Create: `src/lib/image-map.ts`
- Create: `src/lib/image-map-fs.ts` (receives `imageDimensions`, `ensureBake`, `applyOpsWithPerspective` moved from `src/lib/widget-helpers.ts:236-330`)
- Modify: `src/lib/widget-helpers.ts` (delete the moved functions and their `sharp` / `node:fs` / `node:path` / `node:crypto` / `originals` / `perspective-resample` imports; keep `renderPicture` as-is for now — Task 6 changes it)
- Modify: `test/lib/widget-image-dimensions.test.ts` (import path only)
- Create: `test/lib/image-map-fs.test.ts`

**Model:** `sonnet` — a code move plus one new module with a clear contract.

**Interfaces:**
- Consumes: `resolveIds` from `src/lib/widget-helpers.ts`; `listSidecarIds` from `src/lib/posts.ts`; `read` from `src/lib/sidecar.ts`; `cacheKey` from `src/lib/hash.ts`.
- Produces:
  ```ts
  // src/lib/image-map.ts
  export interface ImageSource {
    sidecar: Sidecar;
    width: number;
    height: number;
    /** Absolute URL for one (width, format, quality) derivative. */
    urlFor(width: number, format: string, quality: number): string;
  }
  /** Keyed by the id string as written in the post (lowercased),
   * so prefix resolution has already happened. */
  export type ImageMap = Map<string, ImageSource>;

  // src/lib/image-map-fs.ts
  export function imageDimensions(siteRoot: string, id: string, sidecar: Sidecar):
    Promise<{ width: number; height: number }>
  export function buildImageMap(siteRoot: string, body: string): Promise<ImageMap>
  ```

- [ ] **Step 1: Write the failing test**

Create `test/lib/image-map-fs.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { buildImageMap } from '../../src/lib/image-map-fs.ts';
import { ingestStream } from '../../src/lib/originals.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-imap-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'bakes', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function seed(root: string, w = 800, h = 600): Promise<string> {
  const bytes = await sharp({
    create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } }
  })
    .jpeg()
    .toBuffer();
  const r = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload' }
  });
  return r.id;
}

test('buildImageMap: full id resolves, dimensions come from disk', async (t) => {
  const root = freshSiteRoot(t);
  const id = await seed(root);
  const map = await buildImageMap(root, `::figure{ids="${id}"}\n`);
  const src = map.get(id);
  assert.ok(src);
  assert.equal(src.width, 800);
  assert.equal(src.height, 600);
  assert.equal(src.sidecar.original, id);
});

test('buildImageMap: a prefix reference is keyed by the prefix as written', async (t) => {
  const root = freshSiteRoot(t);
  const id = await seed(root);
  const short = id.slice(0, 8);
  const map = await buildImageMap(root, `::figure{ids="${short}"}\n`);
  assert.ok(map.get(short), 'prefix key present');
  assert.equal(map.get(short)?.sidecar.original, id);
});

test('buildImageMap: urlFor produces the /img/<id>.<oph>.<fmt> URL', async (t) => {
  const root = freshSiteRoot(t);
  const id = await seed(root);
  const map = await buildImageMap(root, `::figure{ids="${id}"}\n`);
  const url = map.get(id)?.urlFor(640, 'webp', 85) ?? '';
  assert.match(url, new RegExp(`^/img/${id}\\.[0-9a-f]{12}\\.webp$`));
});

test('buildImageMap: unknown and ambiguous ids are absent from the map', async (t) => {
  const root = freshSiteRoot(t);
  await seed(root);
  const map = await buildImageMap(root, '::figure{ids="deadbeef"}\n');
  assert.equal(map.get('deadbeef'), undefined);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --test-name-pattern='buildImageMap'`
Expected: FAIL — module not found.

- [ ] **Step 3: Add `src/lib/image-map.ts`**

```ts
// The facts a renderer needs about one image, gathered before any
// markup is emitted. Server and client build this map their own way
// (image-map-fs.ts / admin/image-map-opfs.ts); the renderer is pure
// string work either side of it.

import type { Sidecar } from '@rkr/image-edit';

export interface ImageSource {
  sidecar: Sidecar;
  /** Pixel dimensions of the image the renderer will actually serve. */
  width: number;
  height: number;
  urlFor(width: number, format: string, quality: number): string;
}

/** Keyed by the id as written in the post, lowercased — prefix
 * resolution happens while the map is built, where the full sidecar
 * list is in hand. A missing key means "unresolvable". */
export type ImageMap = Map<string, ImageSource>;
```

- [ ] **Step 4: Move the filesystem half out of `widget-helpers.ts`**

Cut `imageDimensions`, `ensureBake`, and `applyOpsWithPerspective` (with their doc comments, verbatim) from `src/lib/widget-helpers.ts` into the new `src/lib/image-map-fs.ts`, exporting `imageDimensions`. Delete from `widget-helpers.ts` the now-unused imports: `node:crypto`, `node:fs`, `node:path`, `sharp`, `SHARP_PIXEL_LIMIT`, `bakePath`, `imageInfo`, `resamplePerspective`, `applyOp`/`Op`. Keep `cacheKey` and `OutputFormat` — `renderPicture` still uses them until Task 6. Update `src/widgets/figure.ts` and `test/lib/widget-image-dimensions.test.ts` to import `imageDimensions` from `../lib/image-map-fs.ts` / `../../src/lib/image-map-fs.ts`.

- [ ] **Step 5: Write the prepass in `src/lib/image-map-fs.ts`**

Add above the moved functions:

```ts
import type { Sidecar } from '@rkr/image-edit';

import { cacheKey } from './hash.ts';
import { listSidecarIds } from './posts.ts';
import { read as sidecarRead } from './sidecar.ts';
import type { ImageMap, ImageSource } from './image-map.ts';
import { resolveIds } from './widget-helpers.ts';

const ID_TOKEN = /\b[0-9a-fA-F]{6,64}\b/g;

/** Every image the post body could reference, resolved and measured
 * before rendering starts. Reads run concurrently; the renderer then
 * does no I/O at all. */
export async function buildImageMap(siteRoot: string, body: string): Promise<ImageMap> {
  const raws = [...new Set((body.match(ID_TOKEN) ?? []).map((s) => s.toLowerCase()))];
  if (raws.length === 0) return new Map();
  const known = listSidecarIds(siteRoot);
  const resolved = resolveIds(raws, known);

  const entries = await Promise.all(
    raws.map(async (raw, i): Promise<[string, ImageSource] | null> => {
      const id = resolved[i];
      if (!id) return null;
      const sidecar = await sidecarRead(siteRoot, id);
      if (!sidecar) return null;
      const { width, height } = await imageDimensions(siteRoot, id, sidecar);
      return [raw, makeSource(id, sidecar, width, height)];
    })
  );

  return new Map(entries.filter((e): e is [string, ImageSource] => e !== null));
}

function makeSource(id: string, sidecar: Sidecar, width: number, height: number): ImageSource {
  const ops = sidecar.ops as Parameters<typeof cacheKey>[0]['ops'];
  return {
    sidecar,
    width,
    height,
    urlFor: (w, format, quality) => {
      const oph = cacheKey({
        originalId: id,
        ops,
        variant: { w },
        output: { format: format as Parameters<typeof cacheKey>[0]['output']['format'], quality }
      });
      return `/img/${id}.${oph}.${format}`;
    }
  };
}
```

Circular-import check: `widget-helpers.ts` must **not** import `image-map-fs.ts` (only the reverse). `dpdm --circular` in the hook catches a mistake here.

- [ ] **Step 6: Run the tests**

Run: `npm test -- --test-name-pattern='buildImageMap|imageDimensions'`
Expected: PASS.

Run: `npm run typecheck && npm run circular && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(lib): gather image facts into an ImageMap before rendering"
```

---

## Task 6: Render from the map — `renderPostHtml` goes pure

The largest blast radius in this plan: it touches the live published-page path.

**Files:**
- Modify: `src/lib/content.ts:52-55` (`RenderCtx`)
- Modify: `src/lib/widgets.ts:15-18` (`WidgetCtx`)
- Modify: `src/lib/widget-helpers.ts` (`renderPicture`, `wrapLightboxAnchor`; delete `getKnownIds` + its `WeakMap`)
- Modify: `src/widgets/figure.ts`
- Modify: `src/routes/public.ts:58,85,165,181,197,270,396`
- Modify: `test/widgets/figure.test.ts`, `test/lib/content.test.ts`, `test/lib/content-edge.test.ts`, `test/lib/widgets.test.ts`

**Model:** `opus` — a signature change across the live rendering path where a mistake breaks published pages, not the offline path.

**Interfaces:**
- Consumes: `ImageMap`, `ImageSource` from Task 5; `buildImageMap` from `src/lib/image-map-fs.ts`.
- Produces:
  ```ts
  export interface RenderCtx { images: ImageMap; widgets: WidgetRegistry }   // content.ts
  export interface WidgetCtx { images: ImageMap; widgets: WidgetRegistry }   // widgets.ts
  export function renderPicture(args: PictureArgs): string                   // now sync
  export interface PictureArgs {
    src: ImageSource;
    variants: VariantSpec[];
    fallback: FallbackSpec;
    alt?: string;
    loading?: 'lazy' | 'eager';
    lightbox?: boolean;
  }
  ```

- [ ] **Step 1: Write the failing test — a hand-written map, no filesystem**

Create `test/lib/render-from-map.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Sidecar } from '@rkr/image-edit';

import { parsePost, renderPostHtml } from '../../src/lib/content.ts';
import type { ImageMap } from '../../src/lib/image-map.ts';
import { WidgetRegistry } from '../../src/lib/widgets.ts';
import figureWidget from '../../src/widgets/figure.ts';

const SIDECAR: Sidecar = {
  version: 1,
  original: 'a'.repeat(64),
  source: { kind: 'upload' },
  ops: [],
  outputs: [],
  variants: []
};

function mapWith(key: string): ImageMap {
  return new Map([
    [
      key,
      {
        sidecar: SIDECAR,
        width: 1000,
        height: 500,
        urlFor: (w: number, format: string) => `/fake/${key}-${w}.${format}`
      }
    ]
  ]);
}

function ctx(images: ImageMap) {
  const widgets = new WidgetRegistry();
  widgets.register(figureWidget);
  return { images, widgets };
}

const POST = (ids: string) => `---
title: t
slug: s
---

::figure{ids="${ids}"}
`;

test('renderPostHtml: renders a figure from a hand-written map with no filesystem access', async () => {
  const id = 'a'.repeat(64);
  const html = await renderPostHtml(parsePost(POST(id)).ast, ctx(mapWith(id)));
  assert.match(html, /<picture>/);
  assert.match(html, /\/fake\/[a]{64}-1200\.jpeg/);
  assert.match(html, /--rkr-image-aspect: 2\.0000/);
});

test('renderPostHtml: an id written as a prefix resolves through the map', async () => {
  const short = 'aaaaaaaa';
  const html = await renderPostHtml(parsePost(POST(short)).ast, ctx(mapWith(short)));
  assert.match(html, /\/fake\/aaaaaaaa-1200\.jpeg/);
});

test('renderPostHtml: an id absent from the map renders the unresolved comment', async () => {
  const html = await renderPostHtml(parsePost(POST('deadbeef')).ast, ctx(new Map()));
  assert.match(html, /<!-- figure: no ids resolved -->/);
});

test('renderPicture collapses to a single <img> when every derivative URL is identical', async () => {
  const id = 'b'.repeat(64);
  const images: ImageMap = new Map([
    [
      id,
      { sidecar: SIDECAR, width: 400, height: 400, urlFor: () => 'blob:one' }
    ]
  ]);
  const html = await renderPostHtml(parsePost(POST(id)).ast, ctx(images));
  assert.ok(!html.includes('<source'), 'no <source> when there is one candidate');
  assert.match(html, /<img src="blob:one"/);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --test-name-pattern='hand-written map'`
Expected: FAIL — `RenderCtx` still requires `siteRoot`; type error / runtime error on `ctx.siteRoot`.

- [ ] **Step 3: Change the two context types**

`src/lib/content.ts`:

```ts
import type { ImageMap } from './image-map.ts';

export interface RenderCtx {
  images: ImageMap;
  widgets: WidgetRegistry;
}
```

`src/lib/widgets.ts`:

```ts
import type { ImageMap } from './image-map.ts';

export interface WidgetCtx {
  images: ImageMap;
  widgets: WidgetRegistry;
}
```

- [ ] **Step 4: Rewrite `renderPicture`**

In `src/lib/widget-helpers.ts`, delete `getKnownIds` and `knownIdsByCtx` entirely (their only job was memoizing a `readdirSync` the prepass now does once), delete the `listSidecarIds` import, and replace `PictureArgs` / `renderPicture` / `wrapLightboxAnchor` with:

```ts
import type { ImageSource } from './image-map.ts';

export interface PictureArgs {
  src: ImageSource;
  variants: VariantSpec[];
  fallback: FallbackSpec;
  /** Alt text. Already-escaped or plain string; inlined verbatim. */
  alt?: string;
  loading?: 'lazy' | 'eager';
  /** Wrap in the PhotoSwipe anchor (href + data-pswp-* dimensions). */
  lightbox?: boolean;
}

export function renderPicture(args: PictureArgs): string {
  const { src, variants, fallback, alt = '', loading = 'lazy', lightbox = false } = args;

  const fbUrl = src.urlFor(fallback.w, fallback.format, fallback.quality);
  const formats = unique(variants.flatMap((v) => v.formats));
  const sources: string[] = [];
  const distinct = new Set<string>([fbUrl]);
  for (const format of formats) {
    const entries = variants
      .filter((v) => v.formats.includes(format))
      .map((v) => {
        /* c8 ignore next -- ?? 85 unreachable: every format is in QUALITY_BY_FORMAT */
        const url = src.urlFor(v.w, format, QUALITY_BY_FORMAT[format] ?? 85);
        distinct.add(url);
        return `${url} ${v.w}w`;
      });
    sources.push(`<source type="image/${format}" srcset="${entries.join(', ')}"/>`);
  }

  // A client-side map hands back one blob: URL for every candidate;
  // a srcset of identical URLs is noise, so collapse to the <img>.
  const pictureBlock =
    distinct.size === 1
      ? `<picture>\n<img src="${fbUrl}" alt="${alt}" loading="${loading}" decoding="async"/>\n</picture>`
      : [
          '<picture>',
          ...sources,
          `<img src="${fbUrl}" alt="${alt}" loading="${loading}" decoding="async"/>`,
          '</picture>'
        ].join('\n');

  if (!lightbox) return pictureBlock;
  return wrapLightboxAnchor(pictureBlock, { src, variants, alt });
}

function wrapLightboxAnchor(
  pictureBlock: string,
  ctx: { src: ImageSource; variants: VariantSpec[]; alt: string }
): string {
  const { src, variants, alt } = ctx;
  const widest = variants.reduce((acc, v) => (v.w > acc.w ? v : acc), variants[0] as VariantSpec);
  /* c8 ignore next -- 'webp' is in widest.formats for every figure-widget variant */
  const lbFormat = widest.formats.includes('webp') ? 'webp' : (widest.formats[0] as string);
  /* c8 ignore next -- ?? 85 unreachable: every format is in QUALITY_BY_FORMAT */
  const lbUrl = src.urlFor(widest.w, lbFormat, QUALITY_BY_FORMAT[lbFormat] ?? 85);

  const srcW = src.width || widest.w;
  const srcH = src.height || Math.round(widest.w / 1.5);
  const lbW = Math.min(widest.w, srcW);
  const lbH = Math.max(1, Math.round(lbW * (srcH / srcW)));

  return [
    `<a href="${lbUrl}" data-pswp-width="${lbW}" data-pswp-height="${lbH}" target="_blank" rel="noopener" aria-label="Enlarge image${alt ? `: ${alt}` : ''}">`,
    pictureBlock,
    '</a>'
  ].join('\n');
}
```

Keep the `QUALITY_BY_FORMAT` constant and the `unique` helper. `cacheKey`, `OutputFormat`, and the `hash.ts` / `render.ts` imports are now unused in this file — delete them (biome + knip will flag leftovers).

- [ ] **Step 5: Rewrite `src/widgets/figure.ts` against the map**

Replace `CellInput`, `buildCells`, `loadFirstSidecar`, `renderCell`, `renderInline`, and `resolveAutoAspect`:

```ts
interface CellInput {
  /** Id as written in the post; used for the unresolved comment. */
  rawId: string;
  src: ImageSource | null;
  alt: string;
  caption: string | null;
}

function buildCells(node: DirectiveNode, ctx: WidgetCtx): CellInput[] {
  const idsAndAlts = extractImageIdsAndAlts(node.attributes?.ids, node.attributes?.alts);
  const captions = parsePerImageCaptions(node.attributes?.captions);
  return idsAndAlts.map((ia, i) => ({
    rawId: ia.id,
    src: ctx.images.get(ia.id) ?? null,
    alt: ia.alt,
    caption: captions[i] ?? null
  }));
}

function renderCell(cell: CellInput): string {
  if (!cell.src) {
    return `<!-- figure: unresolved id ${escapeText(cell.rawId)} -->`;
  }
  const alt = escapeAttr(cell.alt);
  const picture = renderPicture({
    src: cell.src,
    variants,
    fallback,
    alt,
    lightbox: true
  });
  const cap = cell.caption ? `\n${escapeText(cell.caption)}` : '';
  const cellAspect = (cell.src.width / Math.max(1, cell.src.height)).toFixed(4);
  return `<div class="rkr-figure-cell" style="--rkr-image-aspect: ${cellAspect}">\n${indent(picture, '  ')}${cap}\n</div>`;
}

function renderInlineFigure(cells: CellInput[], justify: Justify, fit: Fit): string {
  const first = cells[0];
  if (!first?.src) {
    return '<!-- figure: inline mode requires a resolvable id -->';
  }
  const picture = renderPicture({
    src: first.src,
    variants,
    fallback,
    alt: escapeAttr(first.alt)
  });
  return renderShell({
    justify,
    fit,
    widthCss: null,
    aspectCss: null,
    inner: indent(picture, '  '),
    blockCaption: null,
    tag: 'span'
  });
}

function resolveAutoAspect(cells: CellInput[], aspectCss: string | null): string | null {
  if (aspectCss !== null) return aspectCss;
  const first = cells.find((c) => c.src !== null)?.src;
  if (!first) return null;
  return `${first.width || 1}/${first.height || 1}`;
}
```

Then drop `async`/`await` from `renderGrid`, `renderCarousel`, `renderFlow`, and `render` — no I/O remains. Replace `await Promise.all(cells.map((c) => renderCell(c, ctx)))` with `cells.map(renderCell)`, and `cells.every((c) => c.id === null)` with `cells.every((c) => c.src === null)`. Rename the local `renderInline` to `renderInlineFigure` (the name collides conceptually with content.ts's inline renderer; keep call sites in sync). Delete the `sidecarRead`, `getKnownIds`, `resolveIds`, `imageDimensions`, and `Sidecar` imports. `Widget.render` may still return `string | Promise<string>`, so a sync `render` satisfies it unchanged.

- [ ] **Step 6: Build the map in `src/routes/public.ts`**

Each of the three render sites reads the post file, so build the map from the same text before rendering. For `GET /:slug` (around line 393):

```ts
      const raw = await fs.promises.readFile(fullPath, 'utf8');
      const parsed = parsePost(raw);
      const ctx = { images: await buildImageMap(siteRoot, raw), widgets };
```

Same shape for `GET /about` (around line 270) and for the index page's teaser + banner rendering (around lines 165–197): the index builds one map per post body it renders, and the site banner (`_site-banner.md`) builds its own from that file's text. Change the two helper signatures:

```ts
async function extractPostBanner(ast: Root, ctx: RenderCtx): Promise<string | null>
async function extractFirstParagraph(ast: Root, ctx: RenderCtx, maxWords: number): Promise<string | null>
```

importing `RenderCtx` from `../lib/content.ts` rather than restating `{ siteRoot; widgets }`.

- [ ] **Step 7: Repair the renderer tests**

`test/widgets/figure.test.ts`, `test/lib/content.test.ts`, `test/lib/content-edge.test.ts`, and `test/lib/widgets.test.ts` construct `{ siteRoot, widgets }`. Give each file a local helper that builds an `ImageMap` — either `await buildImageMap(root, body)` where the test already seeds a real site root, or a hand-written map like Step 1's for the pure cases. Tests asserting the old `<!-- figure: no sidecar for <id> -->` comment now expect `<!-- figure: unresolved id <raw> -->`; that collapse is intended — a map miss no longer distinguishes "unknown id" from "id with no sidecar".

- [ ] **Step 8: Prove published pages are unchanged**

Before the change, capture a baseline (do this on a worktree of the parent commit, or `git stash` the working tree):

```bash
git stash && npm test -- --test-name-pattern='public' > /tmp/before.txt; git stash pop
```

Better: assert it directly. Add to `test/routes/public-pages.test.ts` a test that renders the repo's existing post fixtures through `GET /:slug` and compares the `<article>` body to a checked-in snapshot — or, if the file already has HTML assertions over those fixtures, simply confirm they still pass unmodified. **Do not weaken an existing published-page assertion to make it pass.** If one fails, the renderer changed output and that is the bug.

Run: `npm test`
Expected: PASS, with no edits to published-page HTML assertions.

- [ ] **Step 9: Run the full gauntlet**

Run: `npm run typecheck && npm run lint && npm run circular && npm run knip:gate && npm run test:coverage`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(render): render from a prebuilt ImageMap instead of reading the filesystem"
```

- [ ] **Step 11: Independent review**

Run `/review-step`. This commit touches the live image-rendering path; a fresh read is worth the round trip.

---

## Task 7: Client-side image prepass (OPFS)

**Files:**
- Create: `src/admin/image-map-opfs.ts`
- Create: `test/admin/image-map-opfs.test.ts`
- Create: `test/lib/image-map-equivalence.test.ts`

**Model:** `sonnet` — one new module plus the equivalence harness.

**Interfaces:**
- Consumes: `ImageMap`, `ImageSource`; `listDir`, `readJson`, `readBlob` from `src/admin/opfs.ts`; `resolveIds` from `src/lib/widget-helpers.ts`.
- Produces:
  ```ts
  export interface OpfsMapOpts {
    /** Pixel size of an image blob. Defaults to createImageBitmap. */
    decode?: (blob: Blob) => Promise<{ width: number; height: number }>;
    /** Blob → URL. Defaults to URL.createObjectURL. */
    toUrl?: (blob: Blob) => string;
  }
  export function buildImageMapFromOpfs(body: string, opts?: OpfsMapOpts): Promise<ImageMap>
  export const MISSING_IMAGE_URL: string;   // inline data: placeholder
  ```

`src/lib/widget-helpers.ts` must stay browser-safe for this import to work — Task 5 removed its node imports; confirm with `npx tsc -p tsconfig.browser.json --noEmit` after adding `src/admin/image-map-opfs.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/admin/image-map-opfs.test.ts`, following `test/admin/opfs.test.ts` for the mock installation idiom:

```ts
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { installMockOpfs, resetMockOpfs } from './opfs-mock.ts';

installMockOpfs();

const ID = 'c'.repeat(64);
const SIDECAR = {
  version: 1,
  original: ID,
  source: { kind: 'upload', uploadWidth: 300, uploadHeight: 150 },
  ops: [],
  outputs: [],
  variants: []
};

beforeEach(() => resetMockOpfs());

async function seedSidecar(ops: unknown[] = []): Promise<void> {
  const { writeJson } = await import('../../src/admin/opfs.ts');
  await writeJson(`sidecars/${ID}.json`, { ...SIDECAR, ops });
}

async function seedBlob(path: string): Promise<void> {
  const { writeBlob } = await import('../../src/admin/opfs.ts');
  await writeBlob(path, new Blob([new Uint8Array([1, 2, 3])]));
}

const opts = {
  decode: async () => ({ width: 640, height: 480 }),
  toUrl: () => 'blob:fake'
};

test('client prepass: pinned original yields a blob: URL', async () => {
  const { buildImageMapFromOpfs } = await import('../../src/admin/image-map-opfs.ts');
  await seedSidecar();
  await seedBlob(`originals/${ID}.jpg`);
  const map = await buildImageMapFromOpfs(`::figure{ids="${ID}"}`, opts);
  const src = map.get(ID);
  assert.ok(src);
  assert.equal(src.urlFor(640, 'webp', 85), 'blob:fake');
  assert.deepEqual({ w: src.width, h: src.height }, { w: 640, h: 480 });
});

test('client prepass: no OPFS bytes yields the placeholder URL', async () => {
  const { buildImageMapFromOpfs, MISSING_IMAGE_URL } = await import(
    '../../src/admin/image-map-opfs.ts'
  );
  await seedSidecar();
  const map = await buildImageMapFromOpfs(`::figure{ids="${ID}"}`, opts);
  assert.equal(map.get(ID)?.urlFor(640, 'webp', 85), MISSING_IMAGE_URL);
});

test('client prepass: ops present + bake missing falls back to sidecar metadata dims', async () => {
  const { buildImageMapFromOpfs } = await import('../../src/admin/image-map-opfs.ts');
  const { writeJson } = await import('../../src/admin/opfs.ts');
  await writeJson(`sidecars/${ID}.json`, {
    ...SIDECAR,
    ops: [{ type: 'rotate', degrees: 90 }],
    metadata: { width: 111, height: 222 }
  });
  await seedBlob(`originals/${ID}.jpg`);
  const map = await buildImageMapFromOpfs(`::figure{ids="${ID}"}`, opts);
  assert.deepEqual({ w: map.get(ID)?.width, h: map.get(ID)?.height }, { w: 111, h: 222 });
});

test('client prepass: a prefix reference is keyed by the prefix', async () => {
  const { buildImageMapFromOpfs } = await import('../../src/admin/image-map-opfs.ts');
  await seedSidecar();
  await seedBlob(`originals/${ID}.jpg`);
  const map = await buildImageMapFromOpfs('::figure{ids="cccccccc"}', opts);
  assert.ok(map.get('cccccccc'));
});
```

Check `test/admin/opfs-mock.ts` for the exact exported names (`installMockOpfs` / `resetMockOpfs` or equivalents) and mirror how `test/admin/opfs.test.ts` sequences install → import.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --test-name-pattern='client prepass'`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/admin/image-map-opfs.ts`**

```ts
// Client half of the image prepass (docs/spec-offline.md §6): the same
// scan the server runs, sourced from OPFS. sharp isn't available here,
// so a missing bake falls back to the sidecar's recorded dimensions —
// layout is slightly off until the bake syncs.

import type { Sidecar } from '@rkr/image-edit';

import type { ImageMap, ImageSource } from '../lib/image-map.ts';
import { resolveIds } from '../lib/widget-helpers.ts';
import { listDir, readBlob, readJson } from './opfs.ts';
import { OPFS_DIRS } from './opfs-schema.ts';

/** 1×1 transparent GIF. Stands in for an image whose bytes were never
 * pulled to this device, so the layout still reserves its box. */
export const MISSING_IMAGE_URL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const ID_TOKEN = /\b[0-9a-fA-F]{6,64}\b/g;
const ORIGINAL_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic'];

export interface OpfsMapOpts {
  decode?: (blob: Blob) => Promise<{ width: number; height: number }>;
  toUrl?: (blob: Blob) => string;
}

async function decodeSize(blob: Blob): Promise<{ width: number; height: number }> {
  const bmp = await createImageBitmap(blob);
  const size = { width: bmp.width, height: bmp.height };
  bmp.close();
  return size;
}

export async function buildImageMapFromOpfs(
  body: string,
  opts: OpfsMapOpts = {}
): Promise<ImageMap> {
  const decode = opts.decode ?? decodeSize;
  const toUrl = opts.toUrl ?? ((b: Blob) => URL.createObjectURL(b));

  const raws = [...new Set((body.match(ID_TOKEN) ?? []).map((s) => s.toLowerCase()))];
  if (raws.length === 0) return new Map();

  const known = (await listDir(OPFS_DIRS.SIDECARS))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5));
  const resolved = resolveIds(raws, known);

  const entries = await Promise.all(
    raws.map(async (raw, i): Promise<[string, ImageSource] | null> => {
      const id = resolved[i];
      if (!id) return null;
      const sidecar = await readJson<Sidecar>(`${OPFS_DIRS.SIDECARS}/${id}.json`);
      if (!sidecar) return null;
      const blob = await loadBytes(id, sidecar);
      const url = blob ? toUrl(blob) : MISSING_IMAGE_URL;
      const { width, height } = await sizeOf(blob, sidecar, decode);
      return [raw, { sidecar, width, height, urlFor: () => url }];
    })
  );

  return new Map(entries.filter((e): e is [string, ImageSource] => e !== null));
}

/** The bake when ops are applied, the original otherwise — mirroring
 * the server's file-as-truth rule. */
async function loadBytes(id: string, sidecar: Sidecar): Promise<Blob | null> {
  if ((sidecar.ops ?? []).length > 0) {
    const bake = await readBlob(`${OPFS_DIRS.BAKES}/${id}.webp`);
    if (bake) return bake;
    return null;
  }
  for (const ext of ORIGINAL_EXTS) {
    const b = await readBlob(`${OPFS_DIRS.ORIGINALS}/${id}.${ext}`);
    if (b) return b;
  }
  return null;
}

async function sizeOf(
  blob: Blob | null,
  sidecar: Sidecar,
  decode: (b: Blob) => Promise<{ width: number; height: number }>
): Promise<{ width: number; height: number }> {
  if (blob) {
    try {
      return await decode(blob);
    } catch {
      /* undecodable; fall through to the recorded dimensions */
    }
  }
  const legacy = (sidecar as { metadata?: { width?: number; height?: number } }).metadata;
  if (legacy?.width && legacy.height) return { width: legacy.width, height: legacy.height };
  const src = sidecar.source;
  if (src.uploadWidth && src.uploadHeight) {
    return { width: src.uploadWidth, height: src.uploadHeight };
  }
  return { width: 1, height: 1 };
}
```

Note the ops+bake-missing case returns `null` bytes deliberately: the placeholder is visibly wrong, which is better than showing pre-ops pixels at post-ops dimensions.

- [ ] **Step 4: Run the tests**

Run: `npm test -- --test-name-pattern='client prepass'`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the equivalence test — the one that keeps the preview honest**

Create `test/lib/image-map-equivalence.test.ts`. It renders one fixture post through both prepasses and asserts the HTML matches once image URLs are normalized:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { installMockOpfs, resetMockOpfs } from '../admin/opfs-mock.ts';
import { parsePost, renderPostHtml } from '../../src/lib/content.ts';
import { buildImageMap } from '../../src/lib/image-map-fs.ts';
import { ingestStream } from '../../src/lib/originals.ts';
import { WidgetRegistry } from '../../src/lib/widgets.ts';
import figureWidget from '../../src/widgets/figure.ts';

installMockOpfs();

/** Strip what the two sides are allowed to disagree on: the URLs
 * themselves, and the srcset the client collapses to one candidate. */
function normalize(html: string): string {
  return html
    .replace(/<source[^>]*\/>\n?/g, '')
    .replace(/(src|href)="[^"]*"/g, '$1="URL"');
}

function registry(): WidgetRegistry {
  const w = new WidgetRegistry();
  w.register(figureWidget);
  return w;
}

test('prepass equivalence: one fixture renders identically through both halves', async (t) => {
  resetMockOpfs();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-equiv-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'bakes', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const bytes = await sharp({
    create: { width: 900, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } }
  })
    .jpeg()
    .toBuffer();
  const { id } = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload' }
  });

  const body = `---
title: t
slug: s
---

Some prose with *emphasis*.

::figure{ids="${id.slice(0, 10)}" caption="hello" matrix=1x1}

More prose.
`;

  // Mirror the server's state into OPFS, the way pinPost does.
  const { writeJson, writeBlob } = await import('../../src/admin/opfs.ts');
  const sidecar = JSON.parse(
    fs.readFileSync(path.join(root, 'sidecars', `${id}.json`), 'utf8')
  ) as unknown;
  await writeJson(`sidecars/${id}.json`, sidecar);
  await writeBlob(`originals/${id}.jpg`, new Blob([bytes]));

  const { buildImageMapFromOpfs } = await import('../../src/admin/image-map-opfs.ts');
  const serverHtml = await renderPostHtml(parsePost(body).ast, {
    images: await buildImageMap(root, body),
    widgets: registry()
  });
  const clientHtml = await renderPostHtml(parsePost(body).ast, {
    images: await buildImageMapFromOpfs(body, {
      decode: async () => ({ width: 900, height: 300 }),
      toUrl: () => 'blob:x'
    }),
    widgets: registry()
  });

  assert.equal(normalize(clientHtml), normalize(serverHtml));
});
```

- [ ] **Step 6: Run it**

Run: `npm test -- --test-name-pattern='prepass equivalence'`
Expected: PASS. If it fails, the difference is a real divergence between the two prepasses — fix the prepass, not the normalizer.

- [ ] **Step 7: Browser typecheck + gauntlet**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS. `tsconfig.browser.json` must accept `src/admin/image-map-opfs.ts` — if it drags a node import in through `widget-helpers.ts`, that import is the bug.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(admin): build the image map from OPFS for offline rendering"
```

---

## Task 8: `/admin/view/:slug` — the published-form preview

**Files:**
- Create: `src/admin/site-snapshot.ts`
- Create: `src/admin/preview-page.ts`
- Modify: `src/admin/main.ts` (boot branch)
- Modify: `src/admin/startup.ts` (write the snapshot when online)
- Modify: `src/routes/admin.ts` (`/admin/view/:slug` serves the editor shell)
- Create: `test/admin/preview-page.test.ts`
- Modify: `test/routes/admin.test.ts`

**Model:** `sonnet` — several small pieces with an explicit contract.

**Interfaces:**
- Consumes: `buildImageMapFromOpfs` (Task 7); `renderPostHtml` / `parsePost` (Task 6); `renderPostPage` + `AssetCtx` (Task 1); `proseToMarkdown` (`src/lib/prose-markdown.ts`); `readMeta` / `loadDraft` (`src/admin/draft.ts`); `readRoot` (`src/admin/opfs-schema.ts`).
- Produces:
  ```ts
  // src/admin/site-snapshot.ts
  export interface SiteSnapshot { title: string; tagline?: string; theme: string; hash: string }
  export function captureSiteSnapshot(doc: Document): SiteSnapshot | null
  export function saveSiteSnapshot(snap: SiteSnapshot): Promise<void>
  export function readSiteSnapshot(): Promise<SiteSnapshot | null>
  // src/admin/preview-page.ts
  export function bootPreview(): Promise<void>
  ```

- [ ] **Step 1: Write the failing test**

Create `test/admin/preview-page.test.ts`. Rendering is the part worth testing; keep the DOM swap thin enough that it needs no test. Export the render step separately so the test can call it:

```ts
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { installMockOpfs, resetMockOpfs } from './opfs-mock.ts';

installMockOpfs();
beforeEach(() => resetMockOpfs());

const MARKDOWN = `## Heading

A paragraph.
`;

test('preview: renders a draft into the published page with no network call', async () => {
  const { renderPreviewDocument } = await import('../../src/admin/preview-page.ts');
  const origFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('preview must not fetch');
  }) as typeof fetch;
  try {
    const html = await renderPreviewDocument({
      slug: 'hello',
      title: 'Hello',
      markdown: MARKDOWN,
      snapshot: null
    });
    assert.match(html, /<h1>Hello/);
    assert.match(html, /<h2>Heading<\/h2>/);
    assert.match(html, /<p>A paragraph\.<\/p>/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('preview: omits the comment thread', async () => {
  const { renderPreviewDocument } = await import('../../src/admin/preview-page.ts');
  const html = await renderPreviewDocument({
    slug: 'hello',
    title: 'Hello',
    markdown: MARKDOWN,
    snapshot: null
  });
  assert.ok(!html.includes('rkr-comment-bubble'), 'no comment bubble');
  assert.ok(!html.includes('id="respond"'), 'no comment form');
});

test('preview: no site snapshot → default theme and the given title', async () => {
  const { renderPreviewDocument } = await import('../../src/admin/preview-page.ts');
  const html = await renderPreviewDocument({
    slug: 'hello',
    title: 'Hello',
    markdown: MARKDOWN,
    snapshot: null
  });
  assert.match(html, /\/admin\/static\/themes\/default\.css/);
  assert.ok(!html.includes('/themes/tufte.css'));
  assert.match(html, /<title>Hello — /);
});

test('preview: site snapshot supplies theme, build hash, and site title', async () => {
  const { renderPreviewDocument } = await import('../../src/admin/preview-page.ts');
  const html = await renderPreviewDocument({
    slug: 'hello',
    title: 'Hello',
    markdown: MARKDOWN,
    snapshot: { title: 'rkroll', tagline: 'tag', theme: 'tufte', hash: 'abcdef012345' }
  });
  assert.match(html, /\/admin\/static\/themes\/tufte\.css\?v=abcdef012345/);
  assert.match(html, /rkroll/);
});

test('preview: no public-page scripts are referenced', async () => {
  const { renderPreviewDocument } = await import('../../src/admin/preview-page.ts');
  const html = await renderPreviewDocument({
    slug: 'hello',
    title: 'Hello',
    markdown: MARKDOWN,
    snapshot: null
  });
  assert.ok(!html.includes('<script'), 'static preview loads no scripts');
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- --test-name-pattern='preview:'`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/admin/site-snapshot.ts`**

```ts
// The site chrome the published-form preview needs (title, tagline,
// theme, build hash). None of it is in OPFS, so the editor snapshots
// it from its own server-rendered shell whenever it loads online.

import { readJson, writeJson } from './opfs.ts';
import { OPFS_DIRS } from './opfs-schema.ts';

const SNAPSHOT_PATH = `${OPFS_DIRS.META}/_site.json`;

/** @public */
export interface SiteSnapshot {
  title: string;
  tagline?: string;
  theme: string;
  hash: string;
}

/** Read the values back off the shell's own head + header rather than
 * adding an endpoint: the server already rendered them here. */
export function captureSiteSnapshot(doc: Document): SiteSnapshot | null {
  const title = doc.querySelector('.rkr-site-title a')?.textContent?.trim();
  if (!title) return null;
  const tagline = doc.querySelector('.rkr-site-tagline')?.textContent?.trim();
  let theme = 'default';
  let hash = 'unknown';
  for (const link of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const m = /\/themes\/([a-z0-9-]+)\.css\?v=([^"&]+)$/.exec(link.getAttribute('href') ?? '');
    if (!m) continue;
    hash = m[2] as string;
    if (m[1] !== 'default') theme = m[1] as string;
  }
  return { title, ...(tagline ? { tagline } : {}), theme, hash };
}

export async function saveSiteSnapshot(snap: SiteSnapshot): Promise<void> {
  await writeJson(SNAPSHOT_PATH, snap);
}

export async function readSiteSnapshot(): Promise<SiteSnapshot | null> {
  return readJson<SiteSnapshot>(SNAPSHOT_PATH);
}
```

- [ ] **Step 4: Write `src/admin/preview-page.ts`**

```ts
// /admin/view/:slug — the current buffer rendered as the published
// page. Client-side even when online: a server render would show the
// last saved version, so online and offline would disagree.

import { parsePost, renderPostHtml } from '../lib/content.ts';
import { type ProseDoc, proseToMarkdown } from '../lib/prose-markdown.ts';
import { WidgetRegistry } from '../lib/widgets.ts';
import type { AssetCtx } from '../templates/layout.ts';
import { renderPostPage } from '../templates/post.ts';
import figureWidget from '../widgets/figure.ts';
import { loadDraft, readMeta } from './draft.ts';
import { buildImageMapFromOpfs } from './image-map-opfs.ts';
import { listDir } from './opfs.ts';
import { OPFS_DIRS } from './opfs-schema.ts';
import { readSiteSnapshot, type SiteSnapshot } from './site-snapshot.ts';

const ASSET_BASE = '/admin/static';

export interface PreviewInput {
  slug: string;
  title: string;
  subtitle?: string;
  date?: string;
  markdown: string;
  snapshot: SiteSnapshot | null;
}

function assetsFrom(snapshot: SiteSnapshot | null): AssetCtx {
  return {
    theme: snapshot?.theme ?? 'default',
    hash: snapshot?.hash ?? 'unknown',
    base: ASSET_BASE
  };
}

export async function renderPreviewDocument(input: PreviewInput): Promise<string> {
  const widgets = new WidgetRegistry();
  widgets.register(figureWidget);
  const images = await buildImageMapFromOpfs(input.markdown);
  const parsed = parsePost(`---\ntitle: ${JSON.stringify(input.title)}\nslug: ${JSON.stringify(input.slug)}\n---\n\n${input.markdown}`);
  const bodyHtml = await renderPostHtml(parsed.ast, { images, widgets });

  return renderPostPage({
    site: {
      title: input.snapshot?.title ?? input.title,
      ...(input.snapshot?.tagline ? { tagline: input.snapshot.tagline } : {})
    },
    assets: assetsFrom(input.snapshot),
    title: input.title,
    ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    slug: input.slug,
    ...(input.date ? { date: input.date } : {}),
    bodyHtml,
    isAdmin: true,
    // The thread is server data pinning doesn't pull; fetching it would
    // extend the post-bundle manifest.
    showComments: false,
    scripts: false
  });
}

/** Find the draft holding this slug: the active one first, then any
 * pinned meta that claims it. */
async function findMarkdown(slug: string): Promise<PreviewInput | null> {
  for (const fname of await listDir(OPFS_DIRS.META)) {
    if (!fname.endsWith('.json') || fname.startsWith('_')) continue;
    const draftId = fname.slice(0, -5);
    const meta = await readMeta(draftId);
    if (meta?.slug !== slug) continue;
    const doc = (await loadDraft(draftId)) as ProseDoc | null;
    if (!doc) continue;
    return {
      slug,
      title: meta.title ?? slug,
      ...(meta.subtitle ? { subtitle: meta.subtitle } : {}),
      ...(meta.date ? { date: meta.date } : {}),
      markdown: proseToMarkdown(doc),
      snapshot: await readSiteSnapshot()
    };
  }
  return null;
}

export async function bootPreview(): Promise<void> {
  const slug = decodeURIComponent(location.pathname.replace(/^\/admin\/view\//, ''));
  const input = await findMarkdown(slug);
  if (!input) {
    document.body.textContent = `No local copy of "${slug}". Pin it while online first.`;
    return;
  }
  const html = await renderPreviewDocument(input);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Swap the whole head: the shell's admin <style> block would
  // otherwise override the published layout it was written to frame.
  document.head.replaceChildren();
  for (const el of [...doc.head.children]) document.head.appendChild(document.importNode(el, true));
  document.body.replaceChildren();
  for (const el of [...doc.body.children]) document.body.appendChild(document.importNode(el, true));
}
```

`renderPreviewDocument` takes markdown, not OPFS state, so the tests in Step 1 need no OPFS fixture. `findMarkdown` skips `_`-prefixed meta files so `_site.json` isn't mistaken for a draft.

- [ ] **Step 5: Branch the boot in `src/admin/main.ts`**

Replace the mount trigger at the bottom of the file:

```ts
function boot(): void {
  if (location.pathname.startsWith('/admin/view/')) {
    // Lazy: the preview is a separate chunk esbuild splits out, so the
    // editor path doesn't pay for it.
    void import('./preview-page.ts').then((m) => m.bootPreview());
    return;
  }
  mount();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
```

- [ ] **Step 6: Snapshot the site chrome when the editor loads online**

In `src/admin/startup.ts`'s `runStart`, after `startOnline()`:

```ts
  if (getState() === 'online') {
    const snap = captureSiteSnapshot(document);
    if (snap) void saveSiteSnapshot(snap).catch(() => {});
  }
```

importing `captureSiteSnapshot`/`saveSiteSnapshot` from `./site-snapshot.ts` and `getState` from `./online-state.ts` (already imported there under a different alias — check and reuse). A failed write is not worth surfacing: the preview falls back to the default theme.

- [ ] **Step 7: Serve the shell at `/admin/view/:slug`**

In `src/routes/admin.ts`, factor the `/admin/editor` handler body into a local `sendShell(reply)` and register both routes against it:

```ts
  const sendShell = (reply: FastifyReply) => {
    const nonce = makeCspNonce();
    return reply
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', buildAdminEditorCsp(nonce))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'strict-origin-when-cross-origin')
      .send(
        renderAdminPage({
          site: siteConfig(),
          assets: serverAssets('/admin/static'),
          bundleUrl: `/admin/static/admin/main.js?v=${resolveGitHash().slice(0, 12)}`,
          cspNonce: nonce
        })
      );
  };

  fastify.get('/admin/editor', { ...guard }, async (_req, reply) => sendShell(reply));
  // Same shell, slug-independent: the bundle reads the slug from the
  // path, so one cached copy serves every post.
  fastify.get('/admin/view/:slug', { ...guard }, async (_req, reply) => sendShell(reply));
```

Watch the 500-line cap on `src/routes/admin.ts` (474 lines before this task). If the extraction pushes it over, move `sendShell` + both route registrations into a new `src/routes/admin-shell.ts` exporting `registerShellRoutes(fastify, { guard })`, and call it from `adminRoutes`.

- [ ] **Step 8: Add the route test**

In `test/routes/admin.test.ts`:

```ts
test('/admin/view/:slug serves the same shell as /admin/editor', async (t) => {
  const app = await makeApp(t);
  const editor = await app.inject({ method: 'GET', url: '/admin/editor' });
  const view = await app.inject({ method: 'GET', url: '/admin/view/hello' });
  assert.equal(view.statusCode, 200);
  // Nonces differ per response; compare everything else.
  const strip = (s: string) => s.replace(/nonce="[^"]*"/g, 'nonce="N"');
  assert.equal(strip(view.body), strip(editor.body));
});
```

- [ ] **Step 9: Run the tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 10: Check the bundle**

Run: `npm run build:admin && ls static/admin && node scripts/check-bundle-size.ts 2>/dev/null || npx tsx scripts/check-bundle-size.ts`
Expected: the preview lands in its own chunk; if `check-bundle-size` fails on a new baseline, update `scripts/bundle-size-baseline.json` in this commit and say so in the message.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(admin): render pinned and local posts in published form at /admin/view/:slug"
```

---

## Task 9: Documentation

**Files:**
- Modify: `docs/spec.md` (§2 non-goals, line ~29)
- Modify: `docs/spec-offline.md` (§1 goals, §3 architecture)
- Modify: `docs/implementation.md` (§7 Apache, §8 bundle list)
- Modify: `docs/DEFERRED.md`
- Delete: `docs/superpowers/specs/2026-08-03-admin-shell-offline-design.md`, `docs/superpowers/plans/2026-08-03-admin-shell-offline.md`

**Model:** `sonnet` — prose judgment against the house style.

**Interfaces:** consumes the shipped behavior from Tasks 1–8.

- [ ] **Step 1: Narrow the WYSIWYG non-goal in `docs/spec.md`**

Replace:

```
- WYSIWYG fidelity to the published theme inside the editor (preview
  is not the published page).
```

with:

```
- WYSIWYG fidelity to the published theme inside the editing surface.
  The published form is a separate view at `/admin/view/:slug`.
```

- [ ] **Step 2: Reverse the §3 position in `docs/spec-offline.md`**

Replace the "The admin SPA is **not** service-worker-cached…" sentence with:

```
  The admin shell **is** service-worker-cached, in a cache keyed by the
  build hash: one cache holds exactly one build, so new HTML can never
  pair with old chunks. The shell's assets are served under
  `/admin/static/` so they sit inside the worker's scope. Navigations
  are network-first (online the author gets the fresh server render);
  `/admin/static/*` is cache-first; `/admin/api`, `/admin/sync`, and
  `/admin/post-bundle` are not intercepted at all — the outbox owns
  their offline behavior.
```

Add to §1 Goals:

```
- **Offline viewing of the published form.** A pinned or locally
  composed post renders as the published page at `/admin/view/:slug`,
  with no network and no server render.
```

- [ ] **Step 3: Update `docs/implementation.md`**

In §7 (Apache vhost), after the `/img/*` bullet:

```
- `/admin/static/*` is aliased to the same directory as `/static/*`. The
  admin service worker's scope is `/admin/`, so the shell's assets have
  to be reachable inside it; both prefixes serve identical bytes.
```

In §8, add `static/admin/precache.json` to the bundle list with a one-line note that `build:admin` generates it from the emitted files, and add `src/site/sw-admin-core.ts` beside `sw-admin.js`.

- [ ] **Step 4: Add the deferred item**

Under `## Local-first / sync` in `docs/DEFERRED.md`:

```
- **Offline-launched client can drain a stale bundle to a newer server** — network-first navigation narrows the window to a single launch but does not close it; the fix is a build-hash check at drain time in `/admin/sync/*`, which changes the sync contract. _Revisit when:_ a sync-breaking schema change ships.
```

- [ ] **Step 5: Verify the docs match the code**

Re-read each edited section against the shipped behavior. Check that no doc still says the admin shell is uncached, and that no doc references `RenderCtx.siteRoot`.

Run: `grep -rn "not service-worker-cached\|siteRoot.*RenderCtx" docs/`
Expected: no hits.

- [ ] **Step 6: Delete the working documents and commit**

```bash
git rm docs/superpowers/specs/2026-08-03-admin-shell-offline-design.md docs/superpowers/plans/2026-08-03-admin-shell-offline.md
git add -A
git commit -m "docs: offline admin shell + published-form preview"
```

- [ ] **Step 7: Final whole-branch verification**

Run: `npm run build && npm run check && npm run knip:gate && npm run circular`
Expected: PASS. Then `npm run test:e2e` if a browser is available — the editor's Playwright suite must stay green, since the shell's asset URLs all moved.

---

## Manual verification (after Task 8, before Task 9)

Not automatable, and the point of the whole change:

1. `npm run build && npm start`
2. Open `http://localhost:3000/admin/editor` in Chrome, log in, let the service worker install (DevTools → Application → Service Workers shows `sw-admin.js` activated; Cache Storage shows `rkr-admin-<hash>`).
3. Install the PWA.
4. Pin a post from `/admin/posts`.
5. Go offline (DevTools → Network → Offline, **and** stop the server).
6. Launch the installed PWA. The editor shell must load.
7. Navigate to `/admin/view/<pinned-slug>`. The post must render as the published page, with images.
8. Hard-reload. Both must still work.
