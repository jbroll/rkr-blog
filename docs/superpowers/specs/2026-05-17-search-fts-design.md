# Full-text search (SQLite FTS5) — design

**Source.** User request, 2026-05-17: add a search feature using SQLite
FTS. Indexing the site should create and populate the FTS tables. A
search input belongs in the site header on post-listing pages. Results
show a list of matching posts with a snippet of the matching text.

## Goal

A `GET /search?q=` page backed by an FTS5 index over post title, tags,
and plain-text body. The index is built and kept current entirely by
the existing `runReindex` pipeline (which every post save/delete
already calls). A no-JS search form lives in the header on post-listing
pages. Results are a single relevance-ranked, capped list with a
highlighted body snippet per hit.

## Decisions (locked)

- **Scope.** Anonymous visitors search `status='published'` posts; a
  logged-in admin (`!!req.user`) also gets drafts. Mirrors the existing
  list behavior. System `_`-prefixed posts are never indexed (same as
  `reindex.ts` today).
- **Fields + ranking.** Index `title`, `tags`, plain-text `body`.
  BM25 column weights: title `10.0`, tags `5.0`, body `1.0`.
- **Query syntax.** Simple: whitespace-split words AND-ed, FTS5 syntax
  characters stripped per token, last token prefix-matched (`*`). No
  user-facing operators.
- **Results.** Single capped list (`LIMIT 50`), no pagination.
- **Header control.** A single merged `listControls` header slot (see
  §6); search input persists on the results page, sort toggle does not.

## Existing patterns this follows

- `node:sqlite` (`DatabaseSync`) bundles SQLite 3.50.x with **FTS5 and
  `snippet()`/`bm25()` available** (verified).
- Migrations: numbered `.sql` in `src/migrations/`, applied in order by
  `migrate.ts` inside a transaction. Next is `006`.
- `doReindex` (`src/cli/reindex.ts`) is the single place posts are
  scanned from `content/posts/*.md` and upserted into `posts`. It
  already `parsePost(raw)`s each file. Every admin save
  (`admin.ts`) and delete (`admin-posts.ts`) calls `runReindex`, so
  hooking FTS population into `doReindex` keeps the index live with no
  incremental path.
- `posts` columns: `id, slug, title, status, created_at, updated_at,
  published_at, path`. Body text is NOT stored in `posts` (filesystem
  is source of truth) — the FTS table is the only place body text is
  indexed.
- Pure mdast helpers with unit tests: `src/lib/teaser-truncate.ts` is
  the precedent for `post-text.ts` and `search-query.ts`.
- `siteHead()` header-slot pattern: the just-shipped `sortControl`
  `HeadOpts` slot is the precedent for the merged `listControls` slot.

## 1. Schema — `src/migrations/006_search_fts.sql`

```sql
CREATE VIRTUAL TABLE posts_fts USING fts5(
  slug UNINDEXED, title, tags, body,
  tokenize = 'porter unicode61'
);
```

`slug` is stored but not tokenized — used to join results back to
`posts` for `status` / `published_at` / canonical title. Porter
stemming + unicode61 (diacritic folding) suits prose search. Body text
lives only in this table.

## 2. Plain-text extractor — `src/lib/post-text.ts` (pure)

`extractPlainText(ast: Root): string`. Walks the mdast tree depth-first
and concatenates, separated by single spaces:

- `text` and `inlineCode` node values.
- Heading text (headings are content).

Skips: `yaml` frontmatter node; directive nodes (`leafDirective`,
`containerDirective`, `textDirective` — the `::figure` family, matching
`DIRECTIVE_TYPES` in `content.ts`); fenced `code` blocks (noise/size).
Pure, no I/O. Unit-tested.

## 3. Reindex integration — `doReindex` in `src/cli/reindex.ts`

`doReindex` already calls `parsePost(raw)` per file for frontmatter;
change it to retain the full parse result (`.frontmatter` + `.ast`).
For each non-system post, in the same per-file pass and inside the
existing `upsert` transaction:

```sql
DELETE FROM posts_fts WHERE slug = ?;
INSERT INTO posts_fts (slug, title, tags, body) VALUES (?, ?, ?, ?);
```

`tags` = the post's tag names joined by spaces; `body` =
`extractPlainText(ast)`. The orphan-removal transaction also runs
`DELETE FROM posts_fts WHERE slug = ?` for each removed slug. `_`-slugs
are skipped exactly as today (never indexed, never orphan-checked).

## 4. Query builder — `src/lib/search-query.ts` (pure)

`buildFtsMatch(raw: string): string | null`:

1. Trim; if longer than 200 chars, truncate to 200.
2. Split on whitespace.
3. Per token: remove FTS5 syntax characters (`" * ( ) : ^ - + . /`
   and control chars), leaving safe barewords; drop tokens that become
   empty.
4. If no tokens remain → return `null` (caller renders the prompt
   state, no DB query).
5. Join tokens with a space (FTS5 implicit AND); append `*` to the
   last token (prefix match on the word being typed).

Pure, unit-tested. Sanitization both prevents FTS5 syntax errors and
removes any MATCH-injection vector.

## 5. Route — `GET /search`

The handler is registered in `src/routes/public.ts` (it already imports
the reindex read helpers and follows the public-route + `isAdmin`
conventions). The page template is `src/templates/search.ts`.

- Read `q` (string; missing/empty handled). `isAdmin = !!req.user`.
- `match = buildFtsMatch(q)`. If `null` → render the search page in
  prompt/empty state (no DB hit).
- Otherwise:

```sql
SELECT p.slug, p.title, p.published_at,
       snippet(posts_fts, 3, char(1), char(2), '…', 12) AS snip
FROM posts_fts
JOIN posts p ON p.slug = posts_fts.slug
WHERE posts_fts MATCH ?
  AND (p.status = 'published' OR ?)        -- ? = isAdmin (1/0)
ORDER BY bm25(posts_fts, 10.0, 5.0, 1.0)
LIMIT 50;
```

Column index 3 = `body` → snippet is drawn from the body. The
start/end match arguments are literal sentinel strings unlikely to
occur in prose (U+0001 / U+0002). The route HTML-escapes the entire
snippet string, then replaces the (now-escaped) sentinels with
`<mark>` / `</mark>` — XSS-safe regardless of body content. `Cache-Control` mirrors the existing public.ts convention
(`private, no-store` when `isAdmin`).

## 6. UI — merged header control + results page

- `siteHead()` `HeadOpts` gains a single optional `listControls?:
  string` slot, **replacing the existing `sortControl` slot**
  (rename/absorb). Rendered as one nav group immediately before the
  `Home` link. Non-listing pages (post, admin, settings, 404) pass
  nothing — unchanged.
- Each post-listing page composes the group:
  - **Index / posts-list page** (`index.ts`): `renderSortToggle(...)`
    followed by the search form. Header order: sort, search, Home.
  - **Search results page** (`search.ts`): search form only. The
    ASC/DESC sort toggle is intentionally omitted — results are BM25
    relevance-ranked, not date-ordered.
- Search form: no-JS `GET` form,
  `<form class="rkr-site-search" method="get" action="/search"
  role="search"><input type="search" name="q" placeholder="Search…"
  value="{escaped q}" aria-label="Search posts"></form>`.
- `default.css`: `.rkr-site-search input` collapsed (~9rem), expands
  (~20rem) on `:focus` via a `width` transition. Pure CSS, no JS.
- `src/templates/search.ts` `renderSearchPage(data)`: standard chrome
  with the search box pre-filled; `<h1>`; result `<ul>` reusing
  `.post-list` (title link + date) with an added
  `.rkr-search-snippet` line per hit. Empty states: no query → "Type a
  query to search posts."; query, no hits → "No results for {q}".

## 7. Error handling / edge cases

- Empty / whitespace-only / punctuation-only `q` → prompt state, no DB
  query.
- No matches → "No results for {q}" (q escaped).
- `q` length capped at 200 before processing.
- `q` HTML-escaped in the input `value` and in result rendering.
- FTS table always exists once migration `006` is applied (migrations
  run on reindex and at server start); an empty index simply yields no
  results.
- Snippet highlighting uses the sentinel-then-escape technique so a
  literal `<mark>` in content cannot be injected.

## 8. Testing

- **Unit** `test/lib/search-query.test.ts`: word AND, last-token
  prefix, FTS5-operator stripping, length cap, all-punctuation →
  `null`.
- **Unit** `test/lib/post-text.test.ts`: includes text/inlineCode/
  headings; excludes frontmatter, `::figure`/directives, fenced code.
- **Integration** reindex test: temp site with published + draft +
  `_system` posts; `runReindex`; assert `posts_fts` populated, a query
  returns the expected slug, draft excluded for anon and included for
  admin, `_system` never indexed; deleting a file removes its FTS row.
- **Route** `test/routes/search.test.ts` (or in public tests): prompt
  state, hit list, admin-vs-anon scope, snippet contains `<mark>`,
  XSS attempt in `q` is escaped, `LIMIT 50` cap.
- **Template** `test/templates/search.test.ts`: page structure, header
  search input present with echoed/escaped `q`.
- node:test throughout; the pre-commit gauntlet (incl. c8 coverage) is
  the gate.

## 9. Out of scope (YAGNI)

Pagination (capped at 50), typo/fuzzy matching, typeahead/autocomplete,
in-post match highlighting, search analytics, user-facing FTS
operators.
