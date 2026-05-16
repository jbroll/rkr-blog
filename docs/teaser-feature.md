# Post teaser — design / implementation plan

Status: **implemented** (2026-05-16). See `docs/superpowers/plans/2026-05-16-teaser.md`. Note: the on-disk read path is `siteRoot/<post.path>` (path already includes `content/posts/`), not `siteRoot/content/<post.path>` as drafted in §3.

## Summary

On the logged-out homepage, feature the post currently at the top of the
list as a "teaser": its hero image plus its first paragraph, rendered
above the plain reverse-chrono list. Controlled by a blog-global config
toggle, default off. Anonymous (logged-out) view only — the admin posts
table is untouched.

## Decisions (locked)

- **Global parameter.** A `postTeaser` boolean on the persisted
  site config, default **off**. Surfaced in the admin settings UI.
- **Audience.** Anonymous view only. The admin table never shows a teaser.
- **Scope.** Features whatever post is at `rows[0]` of the *current*
  (filtered / sorted) list — so under a `?tag=` filter or `?sort=asc`
  it tracks the new top post rather than being suppressed.
- **Duplication.** The featured post is **removed** from the list below
  the teaser (no repeated row).
- **Excerpt.** First paragraph rendered to inline HTML (links / emphasis
  preserved), not flattened to plain text.

## 1. Global config parameter — `src/lib/config.ts`

- Add `postTeaser?: boolean` to both `PersistedSiteConfig` and
  `SiteConfig`.
- `pickPersistedFields`:
  `if (typeof r.postTeaser === 'boolean') out.postTeaser = r.postTeaser;`
  — note `false` is a boolean, so an explicit "off" persists and the
  env/default fallback is not re-engaged.
- `siteConfig()`: `if (persisted.postTeaser) out.postTeaser = true;`

## 2. Admin settings UI

- `src/templates/admin-settings.ts`: add a "Posts" section with a
  checkbox `name="postTeaser"`; extend `data.persisted` with
  `postTeaser?: boolean` and pre-check from it.
- `src/routes/admin-settings.ts`:
  - GET passes `persisted.postTeaser` through.
  - POST derives `postTeaser: body.postTeaser !== undefined` (an
    unchecked HTML checkbox sends nothing) and includes it in the
    existing `writePersistedSiteConfig({ ... })` call.

## 3. Teaser assembly — `src/routes/public.ts`, `GET /`

After `rows` is built, only when
`!isAdmin && site.postTeaser && rows.length > 0`:

1. Read `path.join(siteRoot, 'content', rows[0].path)` and
   `parsePost(raw)` — same pattern as the existing `_site-banner.md`
   block in this route.
2. Reuse the file-local `extractPostBanner(ast, ctx)` to splice out and
   render the first `::figure`.
3. New file-local helper `extractFirstParagraph(ast, ctx)`: find the
   first remaining child with `type === 'paragraph'`, render via
   `renderPostHtml({ type: 'root', children: [node] }, ctx)`
   (`renderPostHtml` is async and takes a full `Root`).
4. If **both** a hero figure and a paragraph are found, build
   `teaser = { slug, title, date, bannerHtml, excerptHtml }` and pass
   `posts: rows.slice(1)` to the template. Otherwise pass `rows`
   unchanged and no teaser (the post keeps its normal list row).

Wrap read/parse in try/catch; any failure → no teaser, full list.

Cost: one extra md read + parse + figure dispatch per anonymous index
render when enabled — same profile as the `_site-banner.md` path
already in this route. Anonymous responses stay cacheable (no
`no-store`).

## 4. Template — `src/templates/index.ts`

- Add
  `teaser?: { slug: string; title: string; date?: string; bannerHtml: string; excerptHtml: string }`
  to `IndexPageData`.
- In `renderIndexPage`, anonymous branch only: render a `.rkr-teaser`
  `<article>` (hero, `<h2><a>` title, `<time>`, excerpt `<p>`) before
  the `<ul class="post-list">`.
- `title` / `slug` / `date` go through `escapeText` / `escapeAttr`.
  `bannerHtml` and `excerptHtml` are already trusted renderer output
  (figure widget / `renderPostHtml`, same as a full post body).
- Admin branch unchanged.

## 5. Styling

`.rkr-index-*` styles live per-theme in `static/themes/*.css`. Add
`.rkr-teaser` rules to each theme (default, papermod, tufte) using the
`--rkr-*` custom properties so the teaser inherits each theme's look —
follow the `rkr-theme-writing` skill conventions.

## Edge cases

| Case | Behaviour |
|---|---|
| Empty list | No teaser. |
| Top post has no `::figure` | No teaser; post stays as the normal first row. |
| Figure but no following paragraph | No teaser; post stays as normal row. |
| Missing / malformed `.md` | Caught; no teaser; full list. |
| Tag filter / `sort=asc` active | Teaser tracks the new `rows[0]`. |
| Admin view | Never shows a teaser. |

## Tests

- `config`: `postTeaser` round-trips true/false; `siteConfig()`
  surfaces it.
- `admin-settings`: POST persists checked/unchecked; GET pre-checks.
- `public` e2e: enabled + anonymous + figure → teaser present and
  post #1 absent from the list; admin view unchanged; no-figure post
  → no teaser; tag filter features the top of the filtered list.

## Files touched

`src/lib/config.ts`, `src/templates/admin-settings.ts`,
`src/routes/admin-settings.ts`, `src/routes/public.ts`,
`src/templates/index.ts`, `static/themes/*.css`, plus tests.
