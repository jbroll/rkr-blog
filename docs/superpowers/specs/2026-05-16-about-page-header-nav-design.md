# About page + discoverable header nav — design

**Source.** User request, 2026-05-16: readers can't discover that the
header title links to the posts list. Add explicit header buttons
**[Home] [About] [Login|Logout]**; About is a new editable `/about`
page seeded from roll-along.rkroll.com.

## Goal

A discoverable top-right header nav on every theme, plus an `_about`
system post (editable like any post, edit-linked from settings, seeded
by a new `import-wp about` CLI) served at a standalone `/about` URL
without comments.

## Existing pattern this follows

`_site-banner` is the precedent for a `_`-prefixed *system post*:

- `reindex.ts` skips `slug.startsWith('_')` for both indexing and
  orphan cleanup — system posts live on disk, never in the index.
- `isValidSlug` (`src/routes/admin-post-consts.ts`) already accepts a
  `_`-prefixed system slug, so the editor bundle/save pipeline
  (`admin-post-bundle.ts`, the save route) edits `_about` with no
  changes.
- Settings (`admin-settings.ts`) shows an `Edit banner → / Create
  banner` link gated on `content/posts/_site-banner.md` existing;
  `GET /admin/banner/edit` creates the file from a stub if absent then
  `redirect('/admin/editor?slug=_site-banner&mode=figure')`.
- `import-wp site-banner` fetches from a WP source and HTTP-pushes to a
  running target via admin endpoints.

**Delta from the banner:** the banner is embedded into page headers and
never served as a URL. `GET /:slug` **404s every `_`-slug
unconditionally by design** (`public.ts`: "must never be directly
accessible"). So `_about` needs its own dedicated public route; it is
not reachable at `/_about`.

## Components

### 1. Header nav — `src/templates/layout.ts` + `static/base.css`

`siteHead(site, opts)` renders:
`<header class="rkr-site-head"><div class="rkr-site-head-inner">
<div class="rkr-site-head-brand"><p class="rkr-site-title"><a href="/">…</a></p></div>
<div class="rkr-site-head-auth">{auth}</div></div></header>`
where `{auth}` is a `Login` link (anon) or a `Logout` POST form
(`opts.isAdmin`).

Change: insert a nav group immediately before the
`.rkr-site-head-auth` div:

```html
<nav class="rkr-site-head-nav" aria-label="Site">
  <a href="/">Home</a>
  <a href="/about">About</a>
</nav>
```

The title `<a href="/">` is unchanged (no regression). The auth slot
is unchanged. One theme-independent rule block in `static/base.css`
(`.rkr-site-head-nav` + its links/spacing), since `base.css` is always
loaded and the existing auth button is styled the same way — no
per-theme CSS edits.

### 2. `_about` system post

On-disk file `content/posts/_about.md` with frontmatter:
`slug: _about`, `title: About`, `status: published`. No DB/index row
(reindex skips `_`). Stub created on first edit/seed:
`---\nslug: _about\ntitle: About\nstatus: published\n---\n`.

### 3. Settings edit link — `admin-settings.ts` (route + template)

- Template (`src/templates/admin-settings.ts`): add a row mirroring the
  banner row (`grid-column:1/-1`):
  `<a href="/admin/about/edit">${data.hasAbout ? 'Edit About →' : 'Create About'}</a>`.
  The settings route handler computes `hasAbout =
  fs.existsSync(path.join(siteRoot,'content','posts','_about.md'))`
  exactly like `hasBanner`.
- Route (`src/routes/admin-settings.ts`): add `GET /admin/about/edit`
  (under the same `guard` as `/admin/banner/edit`): if
  `content/posts/_about.md` is absent, write the stub above; then
  `reply.redirect('/admin/editor?slug=_about', 302)` (normal editor
  mode — **no** `mode=figure`).

### 4. Public route `GET /about` — `src/routes/public.ts`

New handler, registered alongside the other public routes:

1. `filePath = path.join(siteRoot, 'content', 'posts', '_about.md')`.
2. If not present → 404 via `renderNotFoundPage({ site, isAdmin })`
   with `setPublicSecurityHeaders`, same shape as the `/:slug` 404
   branch (and `Cache-Control: private, no-store` when `req.user`).
3. Else read + `parsePost` + `renderPostHtml` (same `ctx =
   { siteRoot, widgets }` the `/:slug` handler builds) + optional
   `extractPostBanner` (so an About hero figure works like posts).
4. Render with `renderPostPage({ site, title, slug:'_about', bodyHtml,
   isAdmin, showComments: false, … })`.
5. `setPublicSecurityHeaders`; `Cache-Control: private, no-store` when
   `req.user`.

`renderPostPage` (`src/templates/post.ts`) gains an optional
`showComments?: boolean` (default `true`, preserving every existing
caller). When `false`, the comment list + form block is omitted.
Chosen over a separate `renderPage` template because the page
scaffolding (head, header nav, title, banner, prose width) is
identical — a flag is the DRY minimum and keeps one page renderer.

### 5. `import-wp about` CLI — `src/cli/import-wp.ts` + `src/lib/wp-rest.ts`

Mechanism note: `pushPost` (`src/lib/wp-push.ts`) is hardwired to WP
*posts* — it calls `fetchWpPost` then `importPost`, and the
`/admin/posts` POST sends `slug: frontmatter.slug ?? post.slug`, where
`frontmatter.slug` is rendered from the fetched object's `.slug`
(`wp-import.ts renderFrontmatter` → `slug: ${post.slug}`). A WP **page**
has the same fields `importPost` consumes (`id`, `slug`, `date`,
`title.rendered`, `content.rendered`, optional `featured_media`; no
tags — `renderFrontmatter`'s tag fetch yields none, fine). So the
target slug is controlled purely by the fetched object's `.slug`.

- `wp-rest.ts`: add `fetchWpPage(baseUrl, slug, fetcher?)` hitting
  `${base}/wp-json/wp/v2/pages?slug=${slug}&_fields=id,slug,date,title,content,featured_media`
  (mirrors `listPosts`'s fetcher + `_fields` shape). Returns the single
  matching page as a `WpPost`-shaped object, or throws
  `no page slug=<slug> on <wp-base-url>` if the array is empty.
- `wp-push.ts`: add `pushPage(opts)` — identical to `pushPost` except
  it (1) fetches via `fetchWpPage` and (2) **reassigns
  `page.slug = '_about'`** on the fetched object before
  `importPost`, so the emitted frontmatter slug — and therefore the
  `/admin/posts` POST `slug` — is `_about`. `importPost`,
  `uploadOriginal`, and the `/admin/posts` POST are reused verbatim.
  Factor the shared body of `pushPost` so `pushPage` is a thin variant
  rather than a copy (one private helper taking the already-fetched WP
  object + the target slug).
- `import-wp.ts`: add `about` to `SUBCOMMANDS`; `about(args)` mirrors
  `siteBanner(args)`: require `<wp-base-url>`, `--to <target>`,
  `--token`/`ADMIN_TOKEN`; call `pushPage` with WP source slug `about`
  (verified present on roll-along: page id 12) and `status:
  published`. Usage string:
  `site-admin import-wp about <wp-base-url> --to <target-url> [--token TOKEN]`.

## Data flow

- **Seed:** `import-wp about` → `pushPage` (`fetchWpPage(about)` →
  reassign slug `_about` → `importPost` HTML→md, upload images to
  `${target}/admin/upload`, POST `/admin/posts` slug `_about`) →
  `content/posts/_about.md` on the target.
- **Edit:** Settings → `Edit About` → `/admin/about/edit` (stub if
  absent) → `/admin/editor?slug=_about` → normal save pipeline writes
  `content/posts/_about.md` (reindex runs, skips `_`, harmless).
- **Read:** header `[About]` → `GET /about` → read+render
  `_about.md`, no comments.

## Error handling

- `/about` with no `_about.md` → 404 page (not a 500).
- `/_about` (and any `_`-slug) keeps returning 404 via the existing
  `/:slug` guard — unchanged.
- `fetchWpPage` with no matching page → CLI throws a clear error
  (`no page slug=about on <wp-base-url>`), mirroring `siteBanner`'s
  "no header image" throw.
- `import-wp about` missing `--to`/token → same arg-validation errors
  as `siteBanner`.
- Malformed `_about.md` (bad frontmatter) → `parsePost` throws; the
  `/about` handler wraps read+parse so it 404s rather than 500s
  (match the `/:slug` "unreadable/malformed" tolerance).

## Testing

- **Unit:** `fetchWpPage` (injected fetcher: happy path, no-match
  throw, SSRF guard consistent with `listPosts`). `renderPostPage`
  with `showComments:false` omits the form/list and with default keeps
  them (template test). `siteHead` emits the `[Home][About]` nav and
  still emits the correct Login/Logout auth by `isAdmin`.
- **Route:** `GET /about` → 200 + body + no `rkr-comment-form` when
  `_about.md` present; → 404 when absent. `GET /_about` still 404.
  `GET /admin/about/edit` creates the stub when absent and 302→
  `/admin/editor?slug=_about`; settings page shows Create/Edit by file
  presence (guarded route).
- **e2e (Playwright):** header shows Home/About/Login; About link →
  `/about` renders; from settings, Create About → editor opens on
  `_about`, save persists, `/about` reflects it.
- **CLI:** `fetchWpPage` unit (injected fetcher: happy path → WpPost
  shape; empty array → throw). `pushPage` against a loopback fixture
  (injected `fetcher`/`fetchImage`, like the existing `pushPost`
  tests) asserts the `/admin/posts` POST body carries `slug: "_about"`
  regardless of the source page slug. `import-wp about` arg
  validation; the operator success path is `c8 ignore`d like
  `siteBanner`.

## Out of scope

- No comments, sitemap entry, or index listing for `_about`.
- No new theme CSS files; nav styling lives in `base.css`.
- Other roll-along pages (contact, privacy) — only `about`.
