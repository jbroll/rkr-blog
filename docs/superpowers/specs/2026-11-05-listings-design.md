# Listings and collections

## Goal

A card grid can list the published pages that carry a tag, so adding a
board member or a recipe means creating a page and tagging it. The design
adds as few concepts as possible. A listing is the existing `cards`
macro with its list slot filled from a tag instead of typed rows. A
collection is a tag that has a page with the same slug. A page's place in
a listing comes from a new `order` field.

Replaces the hand-copied card sets in the ECCG port (`/about-us` board
grid, `/news` card bands) and closes gap 14 in
`~/src/eccg-site/port/REPORT.md`. Starts from
`docs/proposal-page-design.md` §3, which this design supersedes where they
differ.

## Scope / Non-goals

In scope:

- One `cards` seed macro replacing `cards`, `people-grid`, `icon-grid`
  and `logo-wall`. The three are retired.
- A tag source for any macro `list` slot.
- A page `order` field.
- Collections: nested URLs, a 301 from the flat URL, "Back to" and
  previous and next links, and collection members kept off `/`, `/posts`
  and the tag rail.

Non-goals, each to get a line in `docs/DEFERRED.md`:

- A feed per tag. No feed exists today.
- A carousel layout.
- Events and calendar (proposal §4).
- A separate listing block, a per-listing manual order, a per-macro field
  map, and a "collection" flag in settings. All rejected to keep the
  concept count down.
- Rewriting the ECCG pages. That is a change in `~/src/eccg-site`
  (`tools/build-pages.mjs`), made after this lands.

## Data model

**Page fields** (`fields` in `content/blocks/*.json`, spec §8a):

- `order`: optional integer. Absent means "after every page that has
  one".

**List slot value.** A macro instance's `list` slot is either the
existing array of records or a tag source:

```json
{ "tag": "board", "sort": "order", "limit": 6 }
```

- `tag`: required non-empty string.
- `sort`: `order` (the default) or `date`.
- `limit`: optional positive integer.

**Row from a page.** Each matching page becomes one record with these
keys, the item field names of the `cards` macro:

| key | value |
| --- | --- |
| `title` | `fields.title` |
| `text` | `fields.excerpt`, or empty |
| `href` | the page's canonical URL (see Collections) |
| `image` | the page's first image id (below), or empty |
| `date` | `fields.date`, or when absent the time the page was first indexed as published |

The first image id is the `ids` value of the first `figure` in the page
body in reading order, including figures in grids. Figures inside macro
instances are not searched. The macro definition can change without a
reindex, so its figures are not indexed. This is my call.

A record has no `button` key. The macro's top-level `button` slot shows
through as every row's label, because `fillTree` shadows slots with item
keys (`blocks-render.ts:85-86`).

**Index.** Migration `010_listing_fields.sql` adds nullable `excerpt`,
`sort_order` and `image` columns to `posts`, and a `position` integer to
`post_tags` holding the tag's index in `fields.tags`. Today `post_tags`
keeps no order (`003_tags.sql`). The reindex code that writes `kind`
(`post-index-blocks.ts:126`) and `syncPostTags` (`:18`) fill them.
Markdown posts leave the new `posts` columns null.

**`cards` macro** (`macros/cards.json`, rewritten):

- Item fields: `image`, `title`, `text` (markdown), `href`, `button`.
- Top-level fields:
  - `heading`, `intro`, `theme`, `edge` and `mask`, as today.
  - `contentAlign` (Left, Center).
  - `cols` (select 2 to 6, default 3).
  - `box` (select Panel or None, default Panel).
  - `button` (text, default `Read more`). An empty label renders no
    button, as today.
- Defaults: three placeholder rows, as today.

The other three looks become instance settings. `people-grid` is `cols`
4, `mask` circle and `box` None with no button. `icon-grid` and
`logo-wall` are `cols` 4 and `box` None.

**Collection.** Tag `T` is a collection when a published `kind: page` row
exists whose slug equals `T` lowercased, and that slug is not one of the
non-collection slugs. A tag that is not a valid slug can never be one. A
page's collection is the first tag in its own `fields.tags` order that is
a collection, other than its own slug. A draft page has a collection by
the same rule; only the collection page must be published. Membership is
computed at request time and never stored.

Non-collection slugs are `RESERVED_SLUGS` (`reserved-slugs.ts`) plus
`img`, `video`, `site-theme` and `pages`. Each of those four already has a
two-segment route (`public-img.ts:132`, `public-video.ts:233`,
`site-theme.ts:30`, `blocks.ts:80`), and Apache serves `/img/*` before
Node sees it (`public.ts:4-6`). A page with one of those slugs stays
legal. Its tag simply never nests anything. `about` is not on the list:
`/about` has its own one-segment route, and `/about/<slug>` is free.

## Behavior contract

**Rendering a tag source.** Before `fillTree` runs, each tag-source slot
is replaced with an array of rows:

- The pages included are published pages, of either kind, whose tags
  include `tag` (compared case-insensitively). The page being rendered is
  excluded.
- `sort: order` orders by `sort_order` ascending with nulls last, then by
  title. `sort: date` orders newest first, then by title.
- `limit` caps the count.
- Public render, `/admin/blocks/_render` and the macro preview all use the
  same resolver, so the editor shows the real cards. `RenderCtx`
  (`content.ts:54`) gains the lookup as a function, so the renderer never
  holds `db`.
- A figure-id prepass on a resolved list sees the row images, so cards
  get their images through the image pipeline.

**Editor.**

- The list field dialog (`macro-list-field.ts`) gets a "Fill from" choice
  between Rows and Tag. Tag shows a tag input, a Sort select (Order or
  Date) and a Limit number input, and hides the rows. Switching back to
  Rows restores the rows saved before.
- Page settings (`page-settings.ts`) gets an Order number input. Empty
  removes the field.

**Collections.**

- Canonical URL: `/<collection>/<slug>` for a page with a collection,
  otherwise `/<slug>`. Every link the site generates to a page uses it:
  - index and teaser links
  - search results
  - listing rows
  - previous and next links
  - "Back to"
  - the home page redirect target
- `GET /:collection/:slug` renders the page when `slug` is a page whose
  collection is `collection` and the viewer may see it. Published pages
  are visible to everyone and drafts to admins, the same rule as `/:slug`
  today (`public.ts:162-165`). Otherwise it returns 404.
- `GET /:slug` for a page that has a collection returns 302 to the
  canonical URL, for admins too. It is not a 301 because membership
  changes, and the codebase sends 301 only to a URL that stays public for
  good (`public.ts:157`, `:189`). The home page rule (301 to `/`) runs
  first. The legacy `/:y/:m/:d/:slug` and `/pages/:slug` redirects point
  straight at the canonical URL instead of chaining through `/:slug`.
- A page with a collection renders "Back to <collection page title>",
  linking to the collection page, followed by previous and next links.
  They cover the published members in `sort: order` order for every
  viewer, admins included. There is no wraparound, and a missing end
  renders nothing. A draft member, shown to an admin, gets "Back to" and
  the links to its published neighbours by its own position. The markup sits after
  the body, inside `<article>`, with class hooks `.rkr-collection-nav`,
  `.rkr-collection-back`, `.rkr-collection-prev` and
  `.rkr-collection-next`. These are documented in `docs/theming.md` in
  the same change.
- Collection members do not appear on `/`, on `/posts` or in tag counts.
  They stay in search. Only `kind: post` rows appear on those views today
  (`post-index.ts:340`, `:377`; `public-index.ts:261`), so this matters
  for posts that join a collection.

**Seeds.**

- `people-grid.json`, `icon-grid.json` and `logo-wall.json` are deleted
  from `macros/`.
- Existing site copies are not removed, so pages that use them still
  render. `site-admin macros` lists `cards` as differing on a site with
  the old copy, and `--update cards` replaces it.

## Failure contract

Save (`validateForSave`, `listSlotProblem` in `blocks.ts:205`; `checkFields`
in `admin-blocks.ts:66`) refuses the following with the existing 400
shape:

- a tag source with an empty or non-string `tag`
- a `sort` outside `order` and `date`
- a `limit` that is not a positive integer
- an unknown key in a tag source
- a `fields.order` that is not an integer

The message names the slot or field.

Render never fails on these:

- A tag with no matching pages resolves to an empty list. The instance
  then renders nothing and gets the existing empty-macro marker in edit
  mode (bf98c18).
- A tag source in a page file that fails the save rules is treated as an
  empty list. Reading checks structure only (spec §8a).
- A page whose first image id does not resolve renders a card with no
  image, as an empty figure does today.
- A `/:collection/:slug` request that does not match returns 404. So does
  one whose collection page is a draft.
- An unpublished collection page makes its members flat again. Their
  `/<slug>` URLs then serve the page with no 301.

## Binding constraints

- Production files are capped at 500 lines (org-hooks `hygiene.sh:59`)
  unless listed in `.size-cap-allow`. Measured on main at 986936c:

  | file | lines | note |
  | --- | --- | --- |
  | `src/lib/post-index.ts` | 423 | tight |
  | `src/routes/public-index.ts` | 270 | |
  | `src/routes/public.ts` | 207 | |
  | `src/admin/page-settings.ts` | 270 | |
  | `src/lib/blocks-render.ts` | 252 | allowlisted |
  | `src/routes/admin-blocks.ts` | 382 | allowlisted |
  | `src/lib/post-index-blocks.ts` | 233 | allowlisted |
  | `src/lib/blocks.ts` | 271 | |
  | `src/admin/macro-list-field.ts` | 127 | |
  | `src/templates/post.ts` | 140 | |
  | `src/lib/stored-page-render.ts` | 120 | |

  New lookup code goes in a new module, not in `post-index.ts`.
- Commit gate (org-hooks `profiles/sci-tiered.yml`): biome, tsc,
  duplicate types, no re-exports, knip, circular imports, size cap, unit
  and e2e tests with c8 coverage.
- Tag names match case-insensitively (`tags.name COLLATE NOCASE`,
  `003_tags.sql`). They are only trimmed and never slugged
  (`syncPostTags`, `post-index-blocks.ts:18`).
- `/:collection/:slug` is a parametric route. Fastify ranks static
  prefixes (`/pages/`, `/img/`, `/video/`, `/admin/`) above it, so those
  keep winning. The non-collection slugs (Data model) make sure no
  canonical URL lands on one of them.
- Placeholder fill yields strings (`fillPlaceholders`,
  `blocks-render.ts:55-60`), so `cols: "{{cols}}"` arrives as `"4"` and
  `box: "{{box}}"` as `"true"`. Today `clampCols` (`grid.ts`) turns a
  non-number into 1, and `box` is on only for `=== true`. `fillTree`
  converts grid `cols` from a digit string to a number, and `box` from
  `"true"` or `""` to a boolean, in filled macro output only. Page-grid
  reading and save rules are unchanged. The `box` select stores `"true"`
  (Panel) or `""` (None).
- Docs change in the same commit as the code: `spec.md` §8a (fields,
  list slots, seeds), §11 (routes), `theming.md` (nav classes),
  `implementation.md` (resolver and URL helper), and `DEFERRED.md`
  (non-goals, and deleting the `cols: 4` item). The `people-grid` /
  `icon-grid` / `logo-wall` references in `spec.md:480-494` are rewritten.

## Testing

- tag source resolves to published pages with the tag; drafts excluded
- tag match is case-insensitive
- page rendering itself is excluded from its own listing
- `sort: order`: ordered pages first by `order`, then unordered by title
- `sort: date`: newest first
- `limit` caps rows
- row fields: title, excerpt as text, canonical href, first figure id,
  date
- first image skips figures inside macro instances
- page with no figure → card with no image
- top-level `button` label shows on tag rows; empty label → no button
- unknown tag → empty instance, marker in edit mode
- save refuses: empty `tag`, bad `sort`, bad `limit`, unknown key,
  non-integer `order`
- page file with an invalid tag source still renders
- `/_render` shows resolved cards
- merged `cards` reproduces the old `people-grid`, `icon-grid` and
  `logo-wall` looks through settings (replaces their cases in
  `macro-seed-look.test.ts`)
- `cols` and `box` set through placeholders render as numbers and
  booleans
- collection exists only for a published `kind: page` with the tag's
  slug
- page's collection = first collection tag in its tag order; its own slug
  never counts
- non-collection slug (`img`, `posts`) never nests its tag's pages;
  `about` does
- page's collection read from tag position after reindex
- `/:collection/:slug` renders a member; wrong collection → 404; draft
  collection page → 404
- draft member: 404 anonymous, rendered for admin at the nested URL
- `/:slug` of a member → 302 to nested URL, admin included; home page
  rule wins
- legacy `/:y/:m/:d/:slug` and `/pages/:slug` → canonical URL in one hop
- flat URL serves again once the collection page is unpublished
- prev/next skip draft siblings for an admin too
- generated links (index, search, rows, nav) use the canonical URL
- Back to, previous and next follow `order` then title; ends render
  nothing
- collection member posts absent from `/`, `/posts`, tag counts; present
  in search
- reindex fills `excerpt`, `sort_order`, `image`; markdown posts null
- dialog: Rows ↔ Tag switch keeps the saved rows; Order input empty
  removes the field (e2e)
- `site-admin macros` reports `cards` differing on a site with the old
  copy; retired seeds absent from a fresh init
