# About Page + Discoverable Header Nav — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a discoverable `[Home] [About] [Login|Logout]` header nav on every theme, an `_about` system post editable from settings and seeded by a new `import-wp about` CLI, served at a standalone `/about` URL without comments.

**Architecture:** `_about` follows the existing `_site-banner` system-post pattern (on-disk `content/posts/_about.md`, excluded from the index, `isValidSlug` already accepts it, edited via the normal editor). A dedicated `GET /about` route renders it (since `GET /:slug` 404s every `_`-slug). The seed CLI reuses the existing `importPost`+upload+`/admin/posts` pipeline via a new `pushPage` that fetches a WP *page* and reassigns its slug to `_about`.

**Tech Stack:** TypeScript (ESM, `--experimental-strip-types`), Fastify, `node:test`, Playwright. Spec: `docs/superpowers/specs/2026-05-16-about-page-header-nav-design.md`.

---

## File Structure

- `src/templates/post.ts` — add `showComments?: boolean` to `PostPageData`; gate the comment bubble + block.
- `src/templates/layout.ts` — `siteHead` emits the `[Home][About]` nav alongside the existing auth control.
- `static/base.css` — one layout-only `.rkr-site-head-nav` rule (always loaded; link colours reuse the themed `.rkr-site-head-auth-btn`).
- `src/lib/wp-rest.ts` — add `fetchWpPage`.
- `src/lib/wp-push.ts` — extract the post-fetch body into `pushWpObject`; add `pushPage`.
- `src/cli/import-wp.ts` — add the `about` subcommand.
- `src/routes/admin-settings.ts` + `src/templates/admin-settings.ts` — `hasAbout` + "Edit/Create About" link + `GET /admin/about/edit`.
- `src/routes/public.ts` — `GET /about`.
- Tests: `test/templates/post.test.ts`, `test/templates/layout.test.ts`, `test/lib/wp-rest-pages.test.ts` (new), `test/lib/wp-push.test.ts`, `test/routes/admin-settings.test.ts`, `test/routes/public-pages.test.ts`, `test/e2e/about-page.spec.ts` (new).

Gate after each task: `npm run check`. Single unit file: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/<path>.test.ts`. Do NOT push or `--no-verify`. Commit on `main` (session convention).

---

### Task 1: `showComments` flag on `renderPostPage`

**Files:**
- Modify: `src/templates/post.ts` (`PostPageData` ~line 16-34; `renderPostPage` body ~35-90)
- Test: `test/templates/post.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/templates/post.test.ts`:

```ts
test('renderPostPage: showComments:false omits the comment bubble + form/list', () => {
  const base = {
    site: { title: 'S' },
    title: 'About',
    slug: '_about',
    bodyHtml: '<p>hi</p>'
  };
  const withC = renderPostPage({ ...base });
  assert.match(withC, /rkr-comment-bubble/);
  assert.match(withC, /rkr-comment-form/);

  const noC = renderPostPage({ ...base, showComments: false });
  assert.doesNotMatch(noC, /rkr-comment-bubble/);
  assert.doesNotMatch(noC, /rkr-comment-form/);
  assert.doesNotMatch(noC, /id="comments"/);
  // Body still renders.
  assert.match(noC, /<p>hi<\/p>/);
});
```

(If `renderPostPage` is not yet imported in this test file, add `import { renderPostPage } from '../../src/templates/post.ts';` to the existing imports — match the file's existing import style.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/templates/post.test.ts`
Expected: FAIL — `showComments:false` still renders the bubble/form.

- [ ] **Step 3: Add the field to `PostPageData`**

In `src/templates/post.ts`, inside `export interface PostPageData extends SiteChrome { … }`, add after the `commentNotice?: string;` line:

```ts
  /** When false, render the page with no comment bubble, list, or
   * form (used by the static /about page). Default true. */
  showComments?: boolean;
```

- [ ] **Step 4: Gate the bubble + block in `renderPostPage`**

In `renderPostPage`, immediately before `const v = bundleVersion();` add:

```ts
  const showComments = post.showComments !== false;
```

Then change the two interpolations in the returned template literal:

- `${commentBubble}` → `${showComments ? commentBubble : ''}`
- `${commentsBlock}` → `${showComments ? commentsBlock : ''}`

Leave `commentBubble` / `commentsBlock` definitions as-is (unused when `showComments` is false; no behavior change for existing callers since the default is true).

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/templates/post.test.ts`
Expected: PASS (new test + all pre-existing post.test.ts tests).

- [ ] **Step 6: Gate + commit**

```bash
npm run check
git add src/templates/post.ts test/templates/post.test.ts
git commit -m "feat(about): showComments flag on renderPostPage"
```

---

### Task 2: Header `[Home] [About]` nav in `siteHead`

**Files:**
- Modify: `src/templates/layout.ts` (`siteHead` ~line 67-85)
- Modify: `static/base.css` (append one rule)
- Test: `test/templates/layout.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/templates/layout.test.ts`:

```ts
test('siteHead: emits Home + About nav and the correct auth control', () => {
  const anon = siteHead({ title: 'S' });
  assert.match(anon, /<nav class="rkr-site-head-nav"[^>]*>/);
  assert.match(anon, /href="\/"[^>]*>Home</);
  assert.match(anon, /href="\/about"[^>]*>About</);
  assert.match(anon, /href="\/login"/); // anon → Login link
  assert.doesNotMatch(anon, /\/admin\/logout/);

  const admin = siteHead({ title: 'S' }, { isAdmin: true });
  assert.match(admin, /href="\/about"[^>]*>About</);
  assert.match(admin, /action="\/admin\/logout"/); // admin → Logout form
});
```

(If `siteHead` isn't imported in this test file, add `import { siteHead } from '../../src/templates/layout.ts';` matching the file's existing import style.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/templates/layout.test.ts`
Expected: FAIL — no `rkr-site-head-nav` / no `About` link.

- [ ] **Step 3: Implement the nav in `siteHead`**

In `src/templates/layout.ts`, in `siteHead`, replace exactly this line:

```ts
    <div class="rkr-site-head-auth">${auth}</div>
```

with:

```ts
    <nav class="rkr-site-head-nav" aria-label="Site">
      <a class="rkr-site-head-auth-btn" href="/">Home</a>
      <a class="rkr-site-head-auth-btn" href="/about">About</a>
      <div class="rkr-site-head-auth">${auth}</div>
    </nav>
```

Rationale: the Home/About links reuse the already-themed `.rkr-site-head-auth-btn` class so every theme styles them consistently with zero per-theme CSS; `.rkr-site-head-auth` stays intact so existing theme rules targeting it still apply.

- [ ] **Step 4: Add the layout-only base.css rule**

Append to `static/base.css`:

```css
/* Header nav group (Home / About / Login|Logout). Layout only —
   link colours come from the theme's .rkr-site-head-auth-btn. base.css
   is always loaded, so this is theme-independent. */
.rkr-site-head-nav { display: flex; align-items: center; gap: 1rem; }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/templates/layout.test.ts`
Expected: PASS (new + all pre-existing layout.test.ts tests; the moderation-page test that asserts `class="rkr-site-head"` / title link still holds — those are unchanged).

- [ ] **Step 6: Gate + commit**

```bash
npm run check
git add src/templates/layout.ts static/base.css test/templates/layout.test.ts
git commit -m "feat(about): discoverable Home/About header nav"
```

---

### Task 3: `fetchWpPage` in `wp-rest.ts`

**Files:**
- Modify: `src/lib/wp-rest.ts`
- Test: `test/lib/wp-rest-pages.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/lib/wp-rest-pages.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchWpPage } from '../../src/lib/wp-rest.ts';
import type { WpFetcher } from '../../src/lib/wp-rest.ts';

const page = {
  id: 12,
  date: '2020-01-02T00:00:00',
  slug: 'about',
  status: 'publish',
  title: { rendered: 'About' },
  content: { rendered: '<p>hi</p>' }
};

test('fetchWpPage: returns the single matching page', async () => {
  const fetcher: WpFetcher = async (url) => {
    assert.match(url, /\/wp-json\/wp\/v2\/pages\?slug=about&_fields=/);
    return new Response(JSON.stringify([page]), { status: 200 });
  };
  const got = await fetchWpPage('https://wp.example/', 'about', fetcher);
  assert.equal(got.slug, 'about');
  assert.equal(got.content.rendered, '<p>hi</p>');
});

test('fetchWpPage: empty array → throws', async () => {
  const fetcher: WpFetcher = async () => new Response('[]', { status: 200 });
  await assert.rejects(
    () => fetchWpPage('https://wp.example', 'nope', fetcher),
    /no page slug=nope on https:\/\/wp\.example/
  );
});

test('fetchWpPage: non-200 → throws', async () => {
  const fetcher: WpFetcher = async () => new Response('x', { status: 500 });
  await assert.rejects(() => fetchWpPage('https://wp.example', 'about', fetcher), /WP fetchWpPage: 500/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/lib/wp-rest-pages.test.ts`
Expected: FAIL — `fetchWpPage` is not exported.

- [ ] **Step 3: Implement `fetchWpPage`**

In `src/lib/wp-rest.ts`, add after `listPosts` (it reuses the existing `WpFetcher`, `defaultWpFetcher`, `stripTrailingSlash`, and `WpPost` already present in the file/imports):

```ts
/** Fetch a single WP *page* by slug (the /pages endpoint, not /posts).
 * Used by `import-wp about`. Returns the page in WpPost shape (the
 * fields importPost consumes are identical). Throws if none match. */
export async function fetchWpPage(
  baseUrl: string,
  slug: string,
  fetcher: WpFetcher = defaultWpFetcher
): Promise<WpPost> {
  const fields = ['id', 'date', 'modified', 'slug', 'status', 'title', 'content', 'featured_media'].join(
    ','
  );
  const url = `${stripTrailingSlash(baseUrl)}/wp-json/wp/v2/pages?slug=${encodeURIComponent(slug)}&_fields=${fields}`;
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`WP fetchWpPage: ${res.status} ${url}`);
  const pages = (await res.json()) as WpPost[];
  const first = pages[0];
  if (!first) throw new Error(`no page slug=${slug} on ${stripTrailingSlash(baseUrl)}`);
  return first;
}
```

If `WpPost` is not already imported in `wp-rest.ts`, add `import type { WpPost } from './wp-import-types.ts';` next to the other type imports (check the top of the file; `listPosts` already returns `WpPost[]` so the type is in scope — reuse the same import).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/lib/wp-rest-pages.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Gate + commit**

```bash
npm run check
git add src/lib/wp-rest.ts test/lib/wp-rest-pages.test.ts
git commit -m "feat(about): fetchWpPage WP /pages client"
```

---

### Task 4: `pushPage` in `wp-push.ts` (extract shared body)

**Files:**
- Modify: `src/lib/wp-push.ts` (`pushPost` ~line 54-142)
- Test: `test/lib/wp-push.test.ts`

This is a pure extraction + one new thin function. `pushPost` currently does: `const post = await fetchWpPost(fetcher, opts.wpBaseUrl, opts.slug);` then the banner/tmpdir/importPost/upload/POST body. Move everything **after** that `fetchWpPost` line into a private `pushWpObject(post, opts)` and make `pushPost` a 2-line wrapper.

- [ ] **Step 1: Write the failing test**

Open `test/lib/wp-push.test.ts`, find an existing `pushPost` loopback-fixture test (it stands up a local server acting as both the WP source and the rkr-blog target with injected `fetcher`/`fetchImage`). Add an analogous test that drives `pushPage`:

```ts
test('pushPage: pushes a WP page with target slug forced to _about', async () => {
  // Reuse this file's existing loopback harness. The fake WP server
  // must answer GET /wp-json/wp/v2/pages?slug=about with a one-element
  // array; the fake target must accept POST /admin/upload and
  // POST /admin/posts (mirror the existing pushPost test's target).
  const captured: { slug?: string } = {};
  // ...stand up servers exactly like the existing pushPost test, but
  // the target's POST /admin/posts handler records body.slug into
  // `captured.slug` and returns { slug: body.slug, inserted: true }...

  const res = await pushPage({
    wpBaseUrl: WP_BASE, // loopback WP fixture base
    slug: 'about',
    toUrl: TARGET_BASE, // loopback target fixture base
    token: 'tok',
    fetcher: injectedFetch,
    fetchImage: injectedImageFetch
  });

  assert.equal(captured.slug, '_about');
  assert.equal(res.slug, '_about');
});
```

Implementer note: model the fixture servers and `injectedFetch`/`injectedImageFetch` exactly on the existing `pushPost` test in this same file (same helpers, same WP-post JSON shape but served at `/wp-json/wp/v2/pages?slug=about`, content `<p>about</p>`, no images so `fetchImage` may be unused). The single new assertion is that `/admin/posts` received `slug: "_about"`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/lib/wp-push.test.ts`
Expected: FAIL — `pushPage` is not exported.

- [ ] **Step 3: Extract `pushWpObject` and add `pushPage`**

In `src/lib/wp-push.ts`:

1. Add the import: in the existing import block add `import { fetchWpPage } from './wp-rest.ts';` (next to the other `./` imports).

2. Locate `export async function pushPost(opts: PushOpts): Promise<PushResult> {`. Its body begins:

```ts
  const fetcher = opts.fetcher ?? fetch;
  const targetBase = stripTrailingSlash(opts.toUrl);
  const auth = `Bearer ${opts.token}`;
  const status = opts.status ?? 'published';

  // 1. Pull from WP, run the local importer into a tempdir.
  //    ...comment...
  const post = await fetchWpPost(fetcher, opts.wpBaseUrl, opts.slug);
```

Replace the **entire `pushPost` function** with this exact pair (the `pushWpObject` body is the original `pushPost` body verbatim from `const bannerUrl = …` through the closing `}` of the `try/finally`, with the four `fetcher/targetBase/auth/status` consts moved into `pushWpObject`):

```ts
/** Shared push pipeline: given an already-fetched WP object (post OR
 * page) whose `.slug` is the desired target slug, import + upload
 * images + POST to <to>/admin/posts. */
async function pushWpObject(post: WpPost, opts: PushOpts): Promise<PushResult> {
  const fetcher = opts.fetcher ?? fetch;
  const targetBase = stripTrailingSlash(opts.toUrl);
  const auth = `Bearer ${opts.token}`;
  const status = opts.status ?? 'published';

  const bannerUrl = post.featured_media
    ? ((await fetchFeaturedMediaUrlDirect(fetcher, opts.wpBaseUrl, post.featured_media)) ??
      undefined)
    : undefined;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-wp-push-'));
  try {
    for (const sub of ['sidecars', 'originals', 'cache/img', 'data', 'content/posts']) {
      fs.mkdirSync(path.join(tmp, sub), { recursive: true });
    }
    const result = await importPost(post, {
      siteRoot: tmp,
      ...(opts.fetchImage ? { fetchImage: opts.fetchImage } : {}),
      ...(bannerUrl ? { bannerUrl } : {})
    });

    const uniqueIds = Array.from(new Set(result.imagesIngested));
    let uploaded = 0;
    let failed = 0;
    for (const id of uniqueIds) {
      try {
        const info = await imageInfo(tmp, id);
        if (!info) throw new Error(`no original on disk for ${id}`);
        await uploadOriginal({ fetcher, targetBase, auth, filePath: info.path });
        uploaded++;
      } catch (err) {
        failed++;
        console.warn(`  ! upload ${id.slice(0, 12)}…: ${(err as Error).message}`);
      }
    }

    const { frontmatter, body } = splitFrontmatter(result.markdown);
    const postRes = await fetcher(`${targetBase}/admin/posts`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: frontmatter.slug ?? post.slug,
        title: frontmatter.title ?? post.title.rendered,
        status,
        date: frontmatter.date ?? post.date,
        markdown: body,
        ...(result.bannerImageId ? { banner: result.bannerImageId } : {})
      })
    });
    if (!postRes.ok) {
      throw new Error(`POST /admin/posts: ${postRes.status} ${await postRes.text()}`);
    }
    const created = (await postRes.json()) as { slug: string; inserted: boolean };

    return {
      slug: created.slug,
      title: frontmatter.title ?? post.title.rendered,
      status,
      imagesUploaded: uploaded,
      imagesFailed: failed,
      inserted: created.inserted
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function pushPost(opts: PushOpts): Promise<PushResult> {
  const fetcher = opts.fetcher ?? fetch;
  const post = await fetchWpPost(fetcher, opts.wpBaseUrl, opts.slug);
  return pushWpObject(post, opts);
}

/** Push a WP *page* (e.g. roll-along's About) as the `_about` system
 * post: fetch the page, force its slug to `_about`, then run the same
 * import/upload/POST pipeline as pushPost. */
export async function pushPage(opts: PushOpts): Promise<PushResult> {
  const page = await fetchWpPage(opts.wpBaseUrl, String(opts.slug), opts.fetcher);
  page.slug = '_about';
  return pushWpObject(page, opts);
}
```

Do not change `PushOpts`, `PushResult`, `uploadOriginal`, `splitFrontmatter`, or any other function. If `fetchWpPost` was a top-level `const`/function used only inside the old `pushPost`, it stays where it is — `pushPost` still calls it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/lib/wp-push.test.ts`
Expected: PASS — new `pushPage` test green AND every pre-existing `pushPost` test still green (pure extraction, no behavior change).

- [ ] **Step 5: Gate + commit**

```bash
npm run check
git add src/lib/wp-push.ts test/lib/wp-push.test.ts
git commit -m "feat(about): pushPage reuses the pushPost pipeline with slug=_about"
```

---

### Task 5: `import-wp about` subcommand

**Files:**
- Modify: `src/cli/import-wp.ts`
- Test: `test/lib/` — add to an existing import-wp CLI test if present, else `test/cli/import-wp-about.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/cli/import-wp-about.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import importWpCmd from '../../src/cli/import-wp.ts';

test('import-wp about: requires --to', async () => {
  await assert.rejects(
    () => importWpCmd(['about', 'https://wp.example']),
    /--to <target-url> is required/
  );
});

test('import-wp about: requires a bearer token', async () => {
  const saved = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  try {
    await assert.rejects(
      () => importWpCmd(['about', 'https://wp.example', '--to', 'https://t.example']),
      /bearer token required/
    );
  } finally {
    if (saved !== undefined) process.env.ADMIN_TOKEN = saved;
  }
});

test('import-wp about: missing base url → usage error', async () => {
  await assert.rejects(() => importWpCmd(['about']), /usage: site-admin import-wp about/);
});
```

(If a sibling `test/cli/import-wp-*.test.ts` exists, mirror its import + structure instead of `test/cli/import-wp-about.test.ts`; both locations are run by the suite.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/cli/import-wp-about.test.ts`
Expected: FAIL — `about` is not a recognized subcommand (hits the generic usage error, not the specific ones).

- [ ] **Step 3: Implement the subcommand**

In `src/cli/import-wp.ts`:

1. Change the import to add `pushPage`:

```ts
import { pushPage, pushPost } from '../lib/wp-push.ts';
```

2. Change `const SUBCOMMANDS = ['list', 'post', 'push', 'site-banner'] as const;` to:

```ts
const SUBCOMMANDS = ['list', 'post', 'push', 'site-banner', 'about'] as const;
```

3. In the usage string inside `importWpCmd`, add a line:

```
  site-admin import-wp about <wp-base-url> --to <target-url> [--token TOKEN]
```

4. Add the dispatch line next to the other `if ((sub as ImportWpSub) === …)` lines:

```ts
  if ((sub as ImportWpSub) === 'about') return about(argv.slice(1));
```

5. Add the `about` function (model arg parsing exactly on `siteBanner`):

```ts
async function about(args: string[]): Promise<void> {
  const wpBaseUrl = args[0];
  if (!wpBaseUrl) {
    throw new Error(
      'usage: site-admin import-wp about <wp-base-url> --to <target-url> [--token TOKEN]'
    );
  }
  const toUrl = stringFlag(args, '--to');
  if (!toUrl) throw new Error('--to <target-url> is required');
  const token = stringFlag(args, '--token') ?? process.env.ADMIN_TOKEN;
  if (!token) throw new Error('bearer token required: pass --token or set ADMIN_TOKEN env');

  /* c8 ignore start -- success path makes real HTTP calls */
  console.log(`==> fetching About page from ${wpBaseUrl}`);
  const result = await pushPage({
    wpBaseUrl,
    slug: 'about',
    toUrl,
    token,
    status: 'published'
  });
  console.log(
    `${result.inserted ? 'created' : 'overwrote'} /_about: ${result.imagesUploaded} image(s)${
      result.imagesFailed > 0 ? `, ${result.imagesFailed} failed` : ''
    }`
  );
  /* c8 ignore stop */
}
```

(`stringFlag` is the same helper `siteBanner` uses — already in this file.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/cli/import-wp-about.test.ts`
Expected: PASS — 3 tests (arg validation hit before any network).

- [ ] **Step 5: Gate + commit**

```bash
npm run check
git add src/cli/import-wp.ts test/cli/import-wp-about.test.ts
git commit -m "feat(about): import-wp about subcommand"
```

---

### Task 6: Settings "Edit/Create About" link + `GET /admin/about/edit`

**Files:**
- Modify: `src/routes/admin-settings.ts` (settings GET handler ~line 66; add a new route near `/admin/banner/edit` ~line 205)
- Modify: `src/templates/admin-settings.ts` (`AdminSettingsPageData` ~line 48; the Banner block ~line 93-97)
- Test: `test/routes/admin-settings.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/routes/admin-settings.test.ts` (mirror that file's existing app/guard setup helpers — reuse whatever `setup`/`buildApp` helper the other tests in the file use; the snippet below assumes an authenticated `app` + a temp `siteRoot` like the existing tests):

```ts
test('GET /admin/about/edit creates _about.md when absent and 302s to the editor', async (t) => {
  const { app, siteRoot } = await setup(t); // same helper the other tests use
  const aboutPath = path.join(siteRoot, 'content', 'posts', '_about.md');
  assert.equal(fs.existsSync(aboutPath), false);

  const res = await app.inject({ method: 'GET', url: '/admin/about/edit' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/admin/editor?slug=_about');
  assert.equal(fs.existsSync(aboutPath), true);
  assert.match(fs.readFileSync(aboutPath, 'utf8'), /slug: _about/);

  // Idempotent: a second call must not overwrite edited content.
  fs.writeFileSync(aboutPath, '---\nslug: _about\ntitle: About\nstatus: published\n---\nEDITED\n');
  await app.inject({ method: 'GET', url: '/admin/about/edit' });
  assert.match(fs.readFileSync(aboutPath, 'utf8'), /EDITED/);
});

test('settings page shows Create/Edit About by file presence', async (t) => {
  const { app, siteRoot } = await setup(t);
  let res = await app.inject({ method: 'GET', url: '/admin/settings' });
  assert.match(res.body, /Create About/);
  fs.mkdirSync(path.join(siteRoot, 'content', 'posts'), { recursive: true });
  fs.writeFileSync(
    path.join(siteRoot, 'content', 'posts', '_about.md'),
    '---\nslug: _about\ntitle: About\nstatus: published\n---\n'
  );
  res = await app.inject({ method: 'GET', url: '/admin/settings' });
  assert.match(res.body, /Edit About →/);
});
```

Ensure `import fs from 'node:fs'` and `import path from 'node:path'` are present in the test file (add if missing, matching existing style).

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/routes/admin-settings.test.ts`
Expected: FAIL — route 404s; settings has no "About" text.

- [ ] **Step 3: Add `hasAbout` to the settings template data**

In `src/templates/admin-settings.ts`, in `interface AdminSettingsPageData`, add right after the `hasBanner: boolean;` line:

```ts
  /** Whether content/posts/_about.md exists on disk. */
  hasAbout: boolean;
```

Then in `renderAdminSettingsPage`, immediately after the Banner block:

```html
  <div class="rkr-admin-settings-banner" style="grid-column:1/-1">
    <a href="/admin/banner/edit">${data.hasBanner ? 'Edit banner →' : 'Create banner'}</a>
  </div>
```

add an analogous About block:

```html
  <div class="rkr-admin-settings-banner" style="grid-column:1/-1">
    <a href="/admin/about/edit">${data.hasAbout ? 'Edit About →' : 'Create About'}</a>
  </div>
```

- [ ] **Step 4: Compute `hasAbout` in the settings GET handler**

In `src/routes/admin-settings.ts`, find:

```ts
      const hasBanner = fs.existsSync(path.join(siteRoot, 'content', 'posts', '_site-banner.md'));
```

Add directly below it:

```ts
      const hasAbout = fs.existsSync(path.join(siteRoot, 'content', 'posts', '_about.md'));
```

and add `hasAbout` to the object passed to `renderAdminSettingsPage({ site, persisted, … })` (next to where `hasBanner` is passed).

- [ ] **Step 5: Add the `/admin/about/edit` route**

In `src/routes/admin-settings.ts`, immediately after the `fastify.get('/admin/banner/edit', { ...guard }, …)` route, add:

```ts
  // GET /admin/about/edit — create _about.md from a stub if absent,
  // then open it in the normal editor (NOT figure mode). Never
  // overwrites existing content (idempotent seed).
  fastify.get('/admin/about/edit', { ...guard }, async (_req, reply) => {
    const aboutPath = path.join(siteRoot, 'content', 'posts', '_about.md');
    if (!fs.existsSync(aboutPath)) {
      fs.mkdirSync(path.dirname(aboutPath), { recursive: true });
      fs.writeFileSync(aboutPath, '---\nslug: _about\ntitle: About\nstatus: published\n---\n');
    }
    return reply.redirect('/admin/editor?slug=_about', 302);
  });
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/routes/admin-settings.test.ts`
Expected: PASS (new tests + all pre-existing).

- [ ] **Step 7: Gate + commit**

```bash
npm run check
git add src/routes/admin-settings.ts src/templates/admin-settings.ts test/routes/admin-settings.test.ts
git commit -m "feat(about): settings Edit/Create About link + /admin/about/edit"
```

---

### Task 7: Public `GET /about` route

**Files:**
- Modify: `src/routes/public.ts` (register near the `GET /:slug` handler; reuse `parsePost`, `renderPostHtml`, `renderNotFoundPage`, `renderPostPage`, `extractPostBanner`, `widgets`, `setPublicSecurityHeaders`, all already in the file)
- Test: `test/routes/public-pages.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/routes/public-pages.test.ts` (mirror the file's existing app/siteRoot setup helper):

```ts
test('GET /about renders _about.md without comments; 404 when absent', async (t) => {
  const { app, siteRoot } = await setup(t); // same helper other tests use

  let res = await app.inject({ method: 'GET', url: '/about' });
  assert.equal(res.statusCode, 404); // no _about.md yet

  fs.mkdirSync(path.join(siteRoot, 'content', 'posts'), { recursive: true });
  fs.writeFileSync(
    path.join(siteRoot, 'content', 'posts', '_about.md'),
    '---\nslug: _about\ntitle: About Us\nstatus: published\n---\nHello from about.\n'
  );

  res = await app.inject({ method: 'GET', url: '/about' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /About Us/);
  assert.match(res.body, /Hello from about\./);
  assert.doesNotMatch(res.body, /rkr-comment-form/);
  assert.doesNotMatch(res.body, /rkr-comment-bubble/);

  // The raw system slug stays inaccessible.
  const sys = await app.inject({ method: 'GET', url: '/_about' });
  assert.equal(sys.statusCode, 404);
});
```

Ensure `fs`/`path` are imported in the test file (match existing style).

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/routes/public-pages.test.ts`
Expected: FAIL — `/about` 404s even when `_about.md` exists (route not registered).

- [ ] **Step 3: Register `GET /about`**

In `src/routes/public.ts`, register this handler alongside the other public `fastify.get` routes (e.g. immediately before the `GET /:slug` handler so the literal path matches before the param route):

```ts
  // GET /about — the _about system post rendered as a standalone page.
  // _-slugs are 404 via /:slug by design, so this reads the file
  // directly and renders without comments.
  fastify.get('/about', async (req, reply) => {
    const site = getSite();
    const isAdmin = !!req.user;
    const filePath = path.join(siteRoot, 'content', 'posts', '_about.md');
    const send404 = () => {
      setPublicSecurityHeaders(reply);
      if (isAdmin) reply.header('Cache-Control', 'private, no-store');
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(renderNotFoundPage({ site, isAdmin }));
    };
    let parsed: ReturnType<typeof parsePost>;
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      parsed = parsePost(raw);
    } catch {
      return send404(); // absent or malformed → 404, never 500
    }
    const ctx = { siteRoot, widgets };
    const bannerHtml = await extractPostBanner(parsed.ast, ctx);
    const bodyHtml = await renderPostHtml(parsed.ast, ctx);
    setPublicSecurityHeaders(reply);
    if (isAdmin) reply.header('Cache-Control', 'private, no-store');
    return reply.type('text/html; charset=utf-8').send(
      renderPostPage({
        site,
        title: parsed.frontmatter.title,
        slug: '_about',
        bodyHtml,
        isAdmin,
        showComments: false,
        ...(bannerHtml ? { bannerHtml } : {})
      })
    );
  });
```

(`getSite`, `siteRoot`, `widgets`, `parsePost`, `renderPostHtml`, `renderNotFoundPage`, `renderPostPage`, `extractPostBanner`, `setPublicSecurityHeaders`, and `fs`/`path` are all already in scope in `public.ts` — confirm by reading the file's top + the `/:slug` handler, which uses the same set.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/routes/public-pages.test.ts`
Expected: PASS (new + all pre-existing public-pages tests).

- [ ] **Step 5: Gate + commit**

```bash
npm run check
git add src/routes/public.ts test/routes/public-pages.test.ts
git commit -m "feat(about): GET /about standalone page route"
```

---

### Task 8: End-to-end coverage

**Files:**
- Create: `test/e2e/about-page.spec.ts`

- [ ] **Step 1: Write the spec**

Create `test/e2e/about-page.spec.ts`. Use `test/e2e/login.spec.ts` / `test/e2e/editor-flow.spec.ts` as the authoritative harness reference (login helper + ADMIN_TOKEN + how the editor saves). Keep intent/assertions as below; adapt selector/login mechanics to match those files exactly.

```ts
import { expect, test } from './coverage-fixtures.ts';

const ADMIN_TOKEN = 'e2e-test-token-do-not-use-in-prod';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await Promise.all([
    page.waitForURL((u) => new URL(u).pathname === '/'),
    page.getByRole('button', { name: /Sign in with token/ }).click()
  ]);
}

test('header nav: anonymous sees Home/About/Login; About renders /about', async ({ page }) => {
  await page.goto('/');
  const nav = page.locator('.rkr-site-head-nav');
  await expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
  await expect(nav.getByRole('link', { name: 'About' })).toHaveAttribute('href', '/about');
  await expect(nav.getByRole('link', { name: 'Login' })).toBeVisible();

  // No _about.md seeded in the e2e siteRoot → /about is a 404 page.
  const r = await page.request.get('/about');
  expect(r.status()).toBe(404);
});

test('settings → Create About → editor opens on _about; /about then renders', async ({ page }) => {
  await login(page);
  await page.goto('/admin/settings');
  await page.getByRole('link', { name: /Create About|Edit About/ }).click();
  await expect(page).toHaveURL(/\/admin\/editor\?slug=_about/);

  // Type a body and save (mirror editor-flow.spec.ts's title/save flow).
  await page.locator('#rkr-title').fill('About');
  // ...insert body text via the editor surface as editor-flow.spec does...
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#rkroll-admin-status')).toContainText(/^saved \//, { timeout: 10_000 });

  await page.goto('/about');
  await expect(page.locator('main')).toContainText('About');
  await expect(page.locator('.rkr-comment-form')).toHaveCount(0);
});
```

- [ ] **Step 2: Run + iterate**

Run: `npm run build:admin && npm run build:site && npx playwright test --config test/playwright.config.ts test/e2e/about-page.spec.ts`
Expected: 2 passed. Align selectors with `editor-flow.spec.ts` if the editor body-entry/save differs; `editor-flow.spec.ts` is authoritative for this codebase.

- [ ] **Step 3: Full gate + commit**

```bash
npm run check
git add test/e2e/about-page.spec.ts
git commit -m "test(about): e2e header nav + settings→editor→/about"
```

---

## Self-Review Notes

- **Spec coverage:** header nav (Task 2 + base.css), `_about` system post (Tasks 6/7 — created via settings stub or `pushPage`), settings edit link + `/admin/about/edit` (Task 6), standalone `/about` no-comments route (Tasks 1+7), `fetchWpPage` (Task 3), `pushPage` slug-reassign reuse (Task 4), `import-wp about` (Task 5), e2e (Task 8). Error handling: `/about` 404 on absent/malformed (Task 7), `fetchWpPage` empty→throw (Task 3), CLI arg validation (Task 5), `/_about` still 404 (asserted Task 7). All spec sections mapped.
- **Type consistency:** `pushPage`/`pushWpObject`/`PushOpts`/`PushResult`/`fetchWpPage`/`WpPost`/`showComments`/`hasAbout` used identically across tasks.
- **No placeholders:** Tasks 1-7 contain complete code. Task 4's `pushWpObject` body is the verbatim existing `pushPost` body (reproduced in full, not "similar to"). Task 8 is an e2e spec where editor body-entry mechanics are explicitly delegated to the authoritative `editor-flow.spec.ts` (a deliberate, called-out reference, not a vague placeholder) — the implementer reads that file for the exact selectors.
- **Risk for executor:** Task 4 is an extraction — the pre-existing `pushPost` tests are the regression guard; they must stay green. Task 8 selectors must match this codebase's real editor (`editor-flow.spec.ts`).
