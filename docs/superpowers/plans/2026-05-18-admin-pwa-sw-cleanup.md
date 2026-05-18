# Admin PWA + Public SW Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the public-page service worker from admin sessions, then add a minimal admin-scoped SW + manifest so the editor is installable as a PWA.

**Architecture:** Three sequential commits. First, decouple public templates from sw-register entirely (admin and anon both get sw-unregister on public pages). Second, wire a new minimal no-op SW + manifest into the admin SPA. Third, delete the now-dead public SW source and test files.

**Tech Stack:** TypeScript (esbuild, tsconfig.browser.json), Fastify `@fastify/static` with `setHeaders`, Node test runner.

---

## File Map

| Action | Path | What changes |
|--------|------|-------------|
| Modify | `src/templates/index.ts` | always `sw-unregister`, remove manifest link |
| Modify | `src/templates/post.ts` | always `sw-unregister`, remove manifest link |
| Modify | `src/templates/search.ts` | always `sw-unregister`, remove manifest link |
| Modify | `src/templates/not-found.ts` | always `sw-unregister`, remove manifest link |
| Modify | `test/templates/post.test.ts` | update admin SW test expectation |
| Create | `src/site/sw-admin.ts` | minimal no-op SW for PWA install requirement |
| Create | `static/admin-manifest.webmanifest` | admin-scoped manifest, reuses existing icons |
| Modify | `src/templates/admin.ts` | add manifest link + SW registration script |
| Modify | `src/routes/admin.ts` | swap `Service-Worker-Allowed` from `sw.js→/` to `sw-admin.js→/admin/` |
| Modify | `package.json` | build:site entries + knip entrypoints |
| Delete | `src/site/sw.ts` | dead |
| Delete | `src/site/sw-core.ts` | dead |
| Delete | `src/site/sw-register.ts` | dead |
| Delete | `test/site/sw-core.test.ts` | dead |
| Delete | `static/manifest.webmanifest` | dead (public manifest) |

---

## Task 1: Public templates — always sw-unregister, drop public manifest

**Files:**
- Modify: `test/templates/post.test.ts:105-109`
- Modify: `src/templates/post.ts` (line with `isAdmin ? 'sw-register' : 'sw-unregister'`)
- Modify: `src/templates/index.ts`, `search.ts`, `not-found.ts` (same pattern + manifest link)

- [ ] **Step 1: Update the failing test first**

In `test/templates/post.test.ts`, replace the admin test (lines 105–109) so it expects `sw-unregister` for both sessions:

```typescript
// was: 'admin view uses sw-register.js, not sw-unregister.js'
test('renderPostPage: admin view also uses sw-unregister.js', () => {
  const html = renderPostPage({ ...base, isAdmin: true });
  assert.match(html, /\/static\/site\/sw-unregister\.js/);
  assert.doesNotMatch(html, /\/static\/site\/sw-register\.js/);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /home/john/src/rkr-blog && node --import tsx/esm --test test/templates/post.test.ts 2>&1 | tail -10
```

Expected: `renderPostPage: admin view also uses sw-unregister.js` fails (finds `sw-register.js`).

- [ ] **Step 3: Update the four public templates**

In each file replace the SW script tag and remove the manifest link. The pattern is identical across all four:

**`src/templates/post.ts`** — find:
```typescript
<script type="module" src="/static/site/${post.isAdmin ? 'sw-register' : 'sw-unregister'}.js${v}" defer></script>
```
Replace with:
```typescript
<script type="module" src="/static/site/sw-unregister.js${v}" defer></script>
```
Also remove the line:
```typescript
<link rel="manifest" href="/static/manifest.webmanifest"/>
```

**`src/templates/index.ts`** — find and replace the same pattern (uses `data.isAdmin`):
```typescript
<script type="module" src="/static/site/${data.isAdmin ? 'sw-register' : 'sw-unregister'}.js${v}" defer></script>
```
→
```typescript
<script type="module" src="/static/site/sw-unregister.js${v}" defer></script>
```
Remove:
```typescript
<link rel="manifest" href="/static/manifest.webmanifest"/>
```

**`src/templates/search.ts`** — same substitution (uses `data.isAdmin`), remove manifest line.

**`src/templates/not-found.ts`** — same substitution (uses `data.isAdmin`), remove manifest line.

- [ ] **Step 4: Run all template tests**

```bash
cd /home/john/src/rkr-blog && node --import tsx/esm --test test/templates/*.test.ts 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 5: Run the full gate**

```bash
cd /home/john/src/rkr-blog && npm run build:site && npm test 2>&1 | tail -30
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/templates/post.ts src/templates/index.ts src/templates/search.ts src/templates/not-found.ts test/templates/post.test.ts
git commit -m "chore: always use sw-unregister on public pages, drop public manifest link"
```

---

## Task 2: Admin SW + manifest

**Files:**
- Create: `src/site/sw-admin.ts`
- Create: `static/admin-manifest.webmanifest`
- Modify: `src/templates/admin.ts`
- Modify: `src/routes/admin.ts`
- Modify: `package.json`
- Create: `test/templates/admin-pwa.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/templates/admin-pwa.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderAdminPage } from '../../src/templates/admin.ts';

const base = {
  site: { title: 'rkroll' },
  bundleUrl: '/static/admin/main.js',
  cspNonce: 'test-nonce',
} as const;

test('renderAdminPage: includes admin manifest link', () => {
  const html = renderAdminPage(base);
  assert.match(html, /\/static\/admin-manifest\.webmanifest/);
});

test('renderAdminPage: includes admin SW registration', () => {
  const html = renderAdminPage(base);
  assert.match(html, /sw-admin\.js/);
  assert.match(html, /scope.*\/admin\//);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /home/john/src/rkr-blog && node --import tsx/esm --test test/templates/admin-pwa.test.ts 2>&1 | tail -10
```

Expected: both tests fail (manifest and SW not yet in template).

- [ ] **Step 3: Create the admin manifest**

Create `static/admin-manifest.webmanifest`:

```json
{
  "name": "rkroll Editor",
  "short_name": "rkroll",
  "description": "rkroll blog editor.",
  "start_url": "/admin/editor",
  "scope": "/admin/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#1a4f7f",
  "icons": [
    { "src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/static/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

(Uses the existing `static/icon-192.png` + `static/icon-512.png`. Screenshots are optional — omitted until real editor captures exist.)

- [ ] **Step 4: Create the minimal admin SW**

Create `src/site/sw-admin.ts`:

```typescript
// Minimal admin service worker. Satisfies the browser PWA install
// requirement. The editor works offline via OPFS — no caching needed here.
const sw = self as unknown as ServiceWorkerGlobalScope;
sw.addEventListener('install', () => sw.skipWaiting());
sw.addEventListener('activate', (e) => e.waitUntil(sw.clients.claim()));
sw.addEventListener('fetch', () => {});
```

- [ ] **Step 5: Wire admin.ts — add manifest link and SW registration**

In `src/templates/admin.ts`, inside `renderAdminPage`, add after the existing `<meta name="viewport"/>` line (or just before `</head>`):

```typescript
<link rel="manifest" href="/static/admin-manifest.webmanifest"/>
<script>
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('/static/site/sw-admin.js',{scope:'/admin/'})
    .catch(function(e){console.warn('rkroll admin sw:',e);});
}
</script>
```

Add it in the `<head>` block, just before the closing `</head>` tag. The inline script is small enough that a CSP nonce is not needed (no `'unsafe-inline'` required — it's a classic `<script src>` equivalent, but since it's inline it needs the nonce). Actually — the admin CSP is strict. Check `src/routes/admin-csp.ts` to see if inline script requires nonce. If so, stamp `nonce="${data.cspNonce}"` on the script tag:

```typescript
<script nonce="${data.cspNonce}">
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('/static/site/sw-admin.js',{scope:'/admin/'})
    .catch(function(e){console.warn('rkroll admin sw:',e);});
}
</script>
```

- [ ] **Step 6: Check admin CSP before committing**

```bash
grep -n "script-src\|unsafe-inline\|nonce" /home/john/src/rkr-blog/src/routes/admin-csp.ts | head -10
```

If `script-src` does not include `'unsafe-inline'`, the inline SW registration script needs `nonce="${data.cspNonce}"` (already included above). Confirm the nonce attribute is on the tag.

- [ ] **Step 7: Update Service-Worker-Allowed in src/routes/admin.ts**

Find the `setHeaders` block (around line 103):
```typescript
setHeaders: (res, filepath) => {
  if (filepath.endsWith(`${path.sep}site${path.sep}sw.js`)) {
    res.setHeader('Service-Worker-Allowed', '/');
  }
}
```

Replace with:
```typescript
setHeaders: (res, filepath) => {
  if (filepath.endsWith(`${path.sep}site${path.sep}sw-admin.js`)) {
    res.setHeader('Service-Worker-Allowed', '/admin/');
  }
}
```

(Drops the `sw.js → /` header; adds `sw-admin.js → /admin/`. The old header is dead once sw.js is gone.)

- [ ] **Step 8: Add sw-admin to build:site and knip entrypoints in package.json**

In `package.json`, in `"build:site"`:
- Remove `src/site/sw.ts src/site/sw-register.ts`
- Add `src/site/sw-admin.ts`

Result (the relevant entries):
```
"build:site": "rm -rf static/site && esbuild src/site/lightbox.ts src/site/carousel.ts src/site/img-retry.ts src/site/copy-link.ts src/site/comment-form.ts src/site/sw-admin.ts src/site/sw-unregister.ts --bundle --splitting --format=esm --target=es2022 --outdir=static/site --sourcemap --minify",
```

In the knip `"entrypoints"` array, remove:
```
"src/site/sw.ts",
"src/site/sw-register.ts",
```
Add:
```
"src/site/sw-admin.ts",
```

- [ ] **Step 9: Build and run tests**

```bash
cd /home/john/src/rkr-blog && npm run build:site && node --import tsx/esm --test test/templates/admin-pwa.test.ts 2>&1 | tail -10
```

Expected: both admin-pwa tests pass.

```bash
cd /home/john/src/rkr-blog && npm test 2>&1 | tail -20
```

Expected: clean (sw-core.test.ts will still pass since sw-core.ts still exists).

- [ ] **Step 10: Commit**

```bash
git add src/site/sw-admin.ts static/admin-manifest.webmanifest src/templates/admin.ts src/routes/admin.ts package.json test/templates/admin-pwa.test.ts
git commit -m "feat: add admin PWA manifest + minimal SW for editor installability"
```

---

## Task 3: Delete dead public SW code

**Files:**
- Delete: `src/site/sw.ts`, `src/site/sw-core.ts`, `src/site/sw-register.ts`
- Delete: `test/site/sw-core.test.ts`
- Delete: `static/manifest.webmanifest`
- Already updated: `package.json` (done in Task 2)

- [ ] **Step 1: Delete the source files**

```bash
rm /home/john/src/rkr-blog/src/site/sw.ts \
   /home/john/src/rkr-blog/src/site/sw-core.ts \
   /home/john/src/rkr-blog/src/site/sw-register.ts \
   /home/john/src/rkr-blog/test/site/sw-core.test.ts \
   /home/john/src/rkr-blog/static/manifest.webmanifest
```

- [ ] **Step 2: Verify nothing imports them**

```bash
cd /home/john/src/rkr-blog && grep -r "sw-core\|sw-register\b\|from.*['\"].*sw['\"]" src/ test/ --include="*.ts" | grep -v "sw-admin\|sw-unregister"
```

Expected: no output.

- [ ] **Step 3: Run the full gate**

```bash
cd /home/john/src/rkr-blog && npm run build:site && npm test 2>&1 | tail -30
```

Expected: clean. The `sw-core.test.ts` is gone so its tests no longer run — that's correct.

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "chore: delete public SW source, test, and manifest (replaced by sw-unregister + admin PWA)"
```

---

## Self-Review

**Spec coverage:**
- ✅ Anon on public pages → sw-unregister (already done before this plan)
- ✅ Admin on public pages → sw-unregister (Task 1)
- ✅ Public manifest removed (Task 1)
- ✅ Admin manifest added, scoped to `/admin/` (Task 2)
- ✅ Admin SW registered, Service-Worker-Allowed header updated (Tasks 2)
- ✅ Dead code deleted (Task 3)
- ✅ Build + knip entries updated (Task 2)
- ✅ Tests updated and added (Tasks 1, 2)

**Placeholder scan:** No TBDs. The one conditional in Task 2 Step 5/6 (nonce) is fully resolved by Step 6.

**Type consistency:** `sw-admin.ts` uses the same `const sw = self as unknown as ServiceWorkerGlobalScope` pattern as the deleted `sw.ts`. No cross-task type mismatches.
