# WordPress import from a SQLite backup

Date: 2026-08-02

## Problem

The WP importer reaches the old blog over its REST API. That works only
while the WP install is up. What we have durably is a `mariadb-dump`
of the database (`../roll-along/db/rollalong.sql`) and the uploads tree
(`../roll-along/site/wp-content/uploads/`).

A slug-level comparison of the dump against the live site found one
published post that never made it across — `one-final-day` ("One final
day", wp id 2358, 2026-05-18) — plus three WP drafts that were never
published and so were never reachable over the public REST endpoints.
There is no way to import any of them today.

## Approach

Add a second source for the import pipeline that reads the backup, and
leave the emit pipeline alone. `importPost` in `lib/wp-import.ts`
already takes a plain `WpPost` and accepts injectable `fetchImage` and
`fetchTagNames`; `lib/wp-rest.ts` is just one producer of `WpPost`. The
SQLite reader is a second producer with identical signatures, so every
caller swaps one module for the other.

## Modules

### `src/lib/wp-dump.ts` — mysqldump → SQLite

Converts a `mysqldump` / `mariadb-dump` `.sql` file into a SQLite
database. Handles the subset a WordPress dump uses:

- Statement splitting that respects `'`, `"` and `` ` `` quoting and
  backslash escapes.
- `CREATE TABLE` with backtick identifiers → SQLite DDL. MySQL types
  map to `INTEGER` (`*int`), `REAL` (`double`/`float`/`decimal`/
  `numeric`), `BLOB` (`blob`/`binary`/`varbinary`), else `TEXT`.
  `PRIMARY KEY` is carried over; `KEY` / `UNIQUE KEY` / `CONSTRAINT` /
  `FOREIGN KEY` clauses are dropped.
- Multi-row `INSERT INTO x VALUES (...),(...)` with MySQL string
  escapes (`\0 \b \n \r \t \Z \\ \' \"`, and `''` for a literal quote).

Unquoted `NULL` becomes SQL NULL; unquoted numerics become numbers;
everything quoted stays text.

Driven by `site-admin wp-dump <dump.sql> <out.db>`, which prints the
table and row counts it wrote.

### `src/lib/wp-sqlite.ts` — the backup source

Same exported names, arguments and return shapes as `lib/wp-rest.ts`,
with the base URL replaced by an open database handle:

| `wp-rest.ts` | `wp-sqlite.ts` reads |
|---|---|
| `listPosts` | `wp_posts` where `post_type='post'` |
| `fetchPost` | same, by `ID` or `post_name` |
| `fetchWpPage` | `wp_posts` where `post_type='page'` |
| `fetchWpSiteInfo` | `wp_options.blogname` / `.blogdescription` |
| `fetchWpSiteBannerUrl` | newest attachment whose `_wp_attached_file` contains `cropped-` |
| `listComments` | `wp_comments` where `comment_approved='1'` |

Field mapping into `WpPost`:

- `content.rendered` ← `post_content`, `title.rendered` ← `post_title`,
  `excerpt.rendered` ← `post_excerpt`
- `date` ← `post_date`, `modified` ← `post_modified`
- `tags` / `categories` ← `wp_term_relationships` → `wp_term_taxonomy`
  → `wp_terms`, split by taxonomy
- `featured_media` ← `wp_postmeta._thumbnail_id`, else 0
- `link` ← `wp_options.siteurl` + `/` + slug

`post_content` is raw Gutenberg HTML rather than REST's
`content.rendered`. For this dump that is a clean substitute: real
`<p>`, `<figure>` and `<img>` elements, `wp-image-<id>` classes, no
shortcodes. The one thing it lacks is `srcset`, which the REST path
used to pick a master image URL — replaced by the attachment lookup
below, which is more accurate anyway.

`fetchTagNames` resolves from `wp_terms` directly, so no network.

### Slugs

WP leaves `post_name` empty until a post is first published, which is
the case for all three drafts in this backup. Slug resolution is
`post_name` → `slugify(post_title)` (`lib/slugify.ts`) →
`post-<id>`. The CLI prints the derived slug so it can be overridden
before pushing.

### Images

`sqliteImageFetcher(db, uploadsRoot)` matches the `fetchImage`
signature `importPost` and `pushPost` already accept:
`(url: string) => Promise<Readable>`. Resolution order:

1. `class="wp-image-<id>"` on the `<img>` → `wp_postmeta` with
   `meta_key='_wp_attached_file'` → `fs.createReadStream` under
   `uploadsRoot`.
2. Fallback: map the `src` URL path onto `uploadsRoot` and strip WP's
   `-<W>x<H>` size suffix to reach the original.

Both paths reach the full-size original rather than the resized variant
WP wrote into the markup. All 1549 `_wp_attached_file` paths in this
dump exist on disk, so an import runs with no network access.

`uploadsRoot` is resolved to an absolute path and every resolved file
path is checked to remain inside it, so a crafted `_wp_attached_file`
value cannot escape the tree.

## CLI

Every `import-wp` subcommand and `import-wp-comments` gains:

```
--from-dump <db>   read from a SQLite backup instead of the REST API
--uploads <dir>    uploads tree root (required with --from-dump)
```

Without `--from-dump` the REST path is unchanged. `pushPost` and
`pushPage` currently fetch the post internally; they gain an optional
injected source so `push` works from the backup too.

`--status` on `list` and `post` filters the query: `publish` (default),
`draft`, or `any`. On `push` it maps a WP status to a local one. A WP
draft imports as a local draft unless `--status published` is passed
explicitly, so pushing a draft never silently publishes it.

## Comments

`wp_comments` in this backup holds 37 approved, 255 unapproved and 502
spam rows. Filtering on `comment_approved='1'` reproduces exactly what
the public REST endpoint returned, so the known spam stays out.
Insertion stays idempotent via the existing `comments.wp_comment_id`
UNIQUE column.

## Testing

Unit tests per module, each building a fixture `.sql` and converting it
in-test:

- `wp-dump`: round-trip of quoting, escapes, embedded `;` and `)`,
  multi-row inserts, type mapping, dropped index clauses.
- `wp-sqlite`: `WpPost` shaping, id vs slug lookup, status filter, tag
  and category split, featured-media resolution, empty-`post_name`
  slug fallback, approved-only comment filter.
- `sqliteImageFetcher`: attachment-id hit, size-suffix fallback,
  missing-file error, traversal attempt rejected.

Then an end-to-end run against the real backup: import `one-final-day`
locally and compare its shape against a REST-imported post.

## Out of scope

Re-importing posts already on the live site. The comparison found the
other 64 published posts present and correct; this work exists to reach
the ones that are not.
