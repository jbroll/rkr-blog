# Full-text search (SQLite FTS5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `GET /search?q=` page backed by an FTS5 index over post title/tags/plain-text body, populated by the existing reindex pipeline, with a no-JS header search form on post-listing pages.

**Architecture:** Standalone `posts_fts` FTS5 virtual table (migration 006), populated inside `doReindex` (reuses its per-file mdast parse), joined back to `posts` for status/date scoping. Pure helpers for text extraction and query sanitization. One merged `listControls` header slot replaces `sortControl`.

**Tech Stack:** TypeScript (ES modules, `--experimental-strip-types`), `node:sqlite` (FTS5/bm25/snippet), Fastify, remark/mdast, `node:test`.

Spec: `docs/superpowers/specs/2026-05-17-search-fts-design.md`

---

### Task 1: Migration — `posts_fts` FTS5 table

**Files:**
- Create: `src/migrations/006_search_fts.sql`
- Test: `test/lib/migrate.test.ts` (add one test)

- [ ] **Step 1: Write the failing test**

Add to `test/lib/migrate.test.ts`:

```ts
test('migration 006 creates the posts_fts FTS5 table', () => {
  const db = open(':memory:');
  try {
    migrate(db);
    const row = db
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='posts_fts'"
      )
      .get();
    assert.equal(row?.name, 'posts_fts');
    // Round-trips an FTS query.
    db.prepare(
      "INSERT INTO posts_fts(slug,title,tags,body) VALUES('s','T','tag','hello world')"
    ).run();
    const hit = db
      .prepare<{ slug: string }>("SELECT slug FROM posts_fts WHERE posts_fts MATCH 'world'")
      .get();
    assert.equal(hit?.slug, 's');
  } finally {
    db.close();
  }
});
```

Ensure the file imports `open` from `../../src/lib/db.ts` and `migrate` from `../../src/lib/migrate.ts` (match existing imports in the file; add `open` if missing).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/migrate.test.ts`
Expected: FAIL — `no such table: posts_fts`.

- [ ] **Step 3: Create the migration**

`src/migrations/006_search_fts.sql`:

```sql
-- Full-text search index over posts. Standalone FTS5 table (not
-- external-content): body text is not a column on `posts`. Populated
-- by doReindex (src/cli/reindex.ts) in the same pass that upserts
-- `posts`; joined back to `posts` on slug for status/date scoping.
-- slug is stored UNINDEXED purely for that join.
CREATE VIRTUAL TABLE posts_fts USING fts5(
  slug UNINDEXED,
  title,
  tags,
  body,
  tokenize = 'porter unicode61'
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/migrations/006_search_fts.sql test/lib/migrate.test.ts
git commit -m "feat(search): migration 006 — posts_fts FTS5 table"
```

---

### Task 2: Plain-text extractor — `src/lib/post-text.ts`

**Files:**
- Create: `src/lib/post-text.ts`
- Test: `test/lib/post-text.test.ts`

- [ ] **Step 1: Write the failing test**

`test/lib/post-text.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePost } from '../../src/lib/content.ts';
import { extractPlainText } from '../../src/lib/post-text.ts';

const md = (body: string) => parsePost(`---\nslug: s\ntitle: T\n---\n\n${body}\n`).ast;

test('collects paragraph text, headings, and inline code', () => {
  const t = extractPlainText(md('# Heading\n\nHello **world** and `code`.'));
  assert.match(t, /Heading/);
  assert.match(t, /Hello/);
  assert.match(t, /world/);
  assert.match(t, /code/);
});

test('skips frontmatter, directives (::figure), and fenced code blocks', () => {
  const t = extractPlainText(
    md('::figure{ids="abc123"}\n\n```js\nconst secret = 1\n```\n\nVisible prose.')
  );
  assert.match(t, /Visible prose/);
  assert.doesNotMatch(t, /abc123/);
  assert.doesNotMatch(t, /secret/);
});

test('returns empty string for an empty body', () => {
  assert.equal(extractPlainText(md('')).trim(), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/post-text.test.ts`
Expected: FAIL — cannot find module `post-text.ts`.

- [ ] **Step 3: Write the implementation**

`src/lib/post-text.ts`:

```ts
// Plain-text extraction from a post's mdast tree, for the search
// index. Skips frontmatter, directive nodes (::figure family), and
// fenced code blocks; keeps prose, headings, and inline code. Pure —
// mirrors the walker style of teaser-truncate.ts.

import type { Nodes, Root } from 'mdast';

const SKIP_TYPES: ReadonlySet<string> = new Set([
  'yaml',
  'code',
  'leafDirective',
  'containerDirective',
  'textDirective'
]);

export function extractPlainText(ast: Root): string {
  const out: string[] = [];

  function walk(node: Nodes): void {
    if (SKIP_TYPES.has(node.type)) return;
    if (node.type === 'text' || node.type === 'inlineCode') {
      const v = (node as { value: string }).value.trim();
      if (v) out.push(v);
      return;
    }
    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children as Nodes[]) walk(child);
    }
  }

  walk(ast);
  return out.join(' ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/post-text.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/post-text.ts test/lib/post-text.test.ts
git commit -m "feat(search): mdast plain-text extractor for the index"
```

---

### Task 3: Query builder — `src/lib/search-query.ts`

**Files:**
- Create: `src/lib/search-query.ts`
- Test: `test/lib/search-query.test.ts`

- [ ] **Step 1: Write the failing test**

`test/lib/search-query.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFtsMatch } from '../../src/lib/search-query.ts';

test('words are AND-ed and the last token is prefix-matched', () => {
  assert.equal(buildFtsMatch('rust async'), 'rust async*');
});

test('single word is prefix-matched', () => {
  assert.equal(buildFtsMatch('rust'), 'rust*');
});

test('FTS5 operator characters are stripped', () => {
  assert.equal(buildFtsMatch('foo* OR -bar "baz"'), 'foo OR bar baz*');
});

test('empty / whitespace / punctuation-only returns null', () => {
  assert.equal(buildFtsMatch(''), null);
  assert.equal(buildFtsMatch('   '), null);
  assert.equal(buildFtsMatch('* - " ( )'), null);
});

test('over-long input is capped at 200 chars before tokenizing', () => {
  const long = `${'a'.repeat(300)} tail`;
  const out = buildFtsMatch(long);
  assert.ok(out && out.length <= 202 && out.endsWith('*'));
  assert.ok(out && !out.includes('tail'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/search-query.test.ts`
Expected: FAIL — cannot find module `search-query.ts`.

- [ ] **Step 3: Write the implementation**

`src/lib/search-query.ts`:

```ts
// Turn a raw user query into a safe FTS5 MATCH string. Words are
// AND-ed; the last word is prefix-matched (the term being typed).
// All FTS5 syntax characters are stripped, which both avoids MATCH
// syntax errors and removes any injection vector. Returns null when
// nothing usable remains (caller renders the prompt state).

const MAX_LEN = 200;
// Keep letters, digits, underscore, and whitespace; drop everything
// else (", *, (, ), :, ^, -, +, ., /, and punctuation).
const STRIP = /[^\p{L}\p{N}_\s]+/gu;

export function buildFtsMatch(raw: string): string | null {
  const capped = raw.trim().slice(0, MAX_LEN);
  const tokens = capped
    .replace(STRIP, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const last = tokens.length - 1;
  return tokens.map((t, i) => (i === last ? `${t}*` : t)).join(' ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/lib/search-query.test.ts`
Expected: PASS (5 tests). Note: `'foo* OR -bar "baz"'` → tokens `foo OR bar baz` → `foo OR bar baz*` (operator chars gone; `OR`/`bar` are now literal terms, not FTS operators).

- [ ] **Step 5: Commit**

```bash
git add src/lib/search-query.ts test/lib/search-query.test.ts
git commit -m "feat(search): safe FTS5 query builder"
```

---

### Task 4: Reindex populates `posts_fts`

**Files:**
- Modify: `src/cli/reindex.ts` (the `doReindex` function)
- Test: `test/cli/reindex.test.ts` (add tests)

- [ ] **Step 1: Write the failing tests**

Add to `test/cli/reindex.test.ts` (uses existing `freshSiteRoot`, `writePost`, `writePostWithTags`, `runReindex`; add `open` import from `../../src/lib/db.ts` and `path`/`fs` already present):

```ts
test('runReindex populates posts_fts with body + tags, queryable by slug', (t) => {
  const root = freshSiteRoot(t);
  writePostWithTags(root, 'a.md', 'alpha', 'Alpha Post', ['rust', 'async'], 'The body mentions tokio.');
  runReindex(root);
  const db = open(path.join(root, 'data', 'site.db'));
  try {
    const hit = db
      .prepare<{ slug: string }>("SELECT slug FROM posts_fts WHERE posts_fts MATCH 'tokio'")
      .get();
    assert.equal(hit?.slug, 'alpha');
    const byTag = db
      .prepare<{ slug: string }>("SELECT slug FROM posts_fts WHERE posts_fts MATCH 'async'")
      .get();
    assert.equal(byTag?.slug, 'alpha');
  } finally {
    db.close();
  }
});

test('runReindex removes the posts_fts row when the source file is gone', (t) => {
  const root = freshSiteRoot(t);
  writePost(root, 'a.md', 'alpha', 'Alpha', 'body one');
  runReindex(root);
  fs.rmSync(path.join(root, 'content', 'posts', 'a.md'));
  runReindex(root);
  const db = open(path.join(root, 'data', 'site.db'));
  try {
    const n = db
      .prepare<{ c: number }>('SELECT COUNT(*) c FROM posts_fts WHERE slug = ?')
      .get('alpha');
    assert.equal(n?.c, 0);
  } finally {
    db.close();
  }
});
```

If `writePostWithTags`'s signature differs, match its existing parameter order in the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/cli/reindex.test.ts`
Expected: FAIL — `no such table: posts_fts` or 0 rows (FTS not populated).

- [ ] **Step 3: Implement FTS population in `doReindex`**

In `src/cli/reindex.ts`:

1. Add import at top with the other lib imports:

```ts
import { extractPlainText } from '../lib/post-text.ts';
```

2. In the per-file loop, the code currently does
`frontmatter = parsePost(raw).frontmatter;`. Change it to keep the
whole parse result so the AST is available:

```ts
let frontmatter: PostFrontmatter;
let ast: import('mdast').Root;
try {
  const parsed = parsePost(raw);
  frontmatter = parsed.frontmatter;
  ast = parsed.ast;
} catch (err) {
  console.error(`reindex: skipping ${filename}: ${(err as Error).message}`);
  continue;
}
```

3. Immediately after the `if (existing) { UPDATE } else { INSERT }`
block and the `postId` resolution (just before `syncPostTags(...)`),
add FTS upsert using the same `postId`/`slug`/`frontmatter`:

```ts
const tagText = Array.isArray(frontmatter.tags)
  ? (frontmatter.tags as string[]).join(' ')
  : '';
db.prepare('DELETE FROM posts_fts WHERE slug = ?').run(slug);
db.prepare(
  'INSERT INTO posts_fts (slug, title, tags, body) VALUES (?, ?, ?, ?)'
).run(slug, frontmatter.title, tagText, extractPlainText(ast));
```

4. In the orphan-removal transaction, where it does
`db.prepare('DELETE FROM posts WHERE id = ?').run(o.id);`, add a
sibling delete keyed on slug:

```ts
db.prepare('DELETE FROM posts WHERE id = ?').run(o.id);
db.prepare('DELETE FROM posts_fts WHERE slug = ?').run(o.slug);
```

(`_`-prefixed slugs are already `continue`d before indexing and
filtered out of the orphan list, so they are never added to or removed
from `posts_fts` — no change needed there.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/cli/reindex.test.ts`
Expected: PASS (all existing reindex tests + the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/cli/reindex.ts test/cli/reindex.test.ts
git commit -m "feat(search): doReindex populates and prunes posts_fts"
```

---

### Task 5: Header — `renderSearchForm` + rename `sortControl` → `listControls`

**Files:**
- Modify: `src/templates/layout.ts` (HeadOpts, siteHead nav, add `renderSearchForm`)
- Modify: `src/templates/index.ts:94` (compose `listControls`)
- Test: `test/templates/layout.test.ts`, `test/templates/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/templates/layout.test.ts`:

```ts
import { renderSearchForm } from '../../src/templates/layout.ts';

test('renderSearchForm is a no-JS GET form with escaped, prefilled q', () => {
  const html = renderSearchForm('a "b" <x>');
  assert.match(html, /<form[^>]*action="\/search"[^>]*method="get"/);
  assert.match(html, /name="q"/);
  assert.match(html, /value="a &quot;b&quot; &lt;x&gt;"/);
  assert.doesNotMatch(html, /value="a "b"/);
});

test('renderSearchForm value is empty when no query given', () => {
  assert.match(renderSearchForm(), /value=""/);
});
```

Add to `test/templates/index.test.ts` (anonymous index keeps the sort
toggle AND now shows the search form, both before the Home link):

```ts
test('renderIndexPage header has both sort toggle and search form', () => {
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 1,
    posts: []
  });
  assert.match(html, /class="rkr-sort-toggle"/);
  assert.match(html, /<form[^>]*action="\/search"/);
  // Search form precedes the Home link in the nav.
  assert.ok(html.indexOf('action="/search"') < html.indexOf('href="/">Home'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/templates/layout.test.ts test/templates/index.test.ts`
Expected: FAIL — `renderSearchForm` not exported; index has no `/search` form.

- [ ] **Step 3: Implement**

In `src/templates/layout.ts`:

1. Rename the `HeadOpts.sortControl` field to `listControls` (keep the doc comment, update wording):

```ts
  /** Trusted HTML injected at the start of the header nav on
   * post-listing pages (sort toggle and/or search form). Omitted
   * everywhere else so these controls stay listing-only. */
  listControls?: string;
```

2. In `siteHead`'s nav block, change
`${opts.sortControl ?? ''}<a class="rkr-site-head-auth-btn" href="/">Home</a>`
to:

```ts
      ${opts.listControls ?? ''}<a class="rkr-site-head-auth-btn" href="/">Home</a>
```

3. Add an exported helper (near `siteHead`; `escapeAttr` is already
imported in this file):

```ts
/** No-JS site search form for the header nav (post-listing pages).
 * GET so it works without JavaScript; the focus-expand is pure CSS. */
export function renderSearchForm(q = ''): string {
  return `<form class="rkr-site-search" method="get" action="/search" role="search"><input type="search" name="q" value="${escapeAttr(q)}" placeholder="Search…" aria-label="Search posts"/></form>`;
}
```

In `src/templates/index.ts`:

4. Add `renderSearchForm` to the existing import from `./layout.ts`.

5. Change line 94 from
`const head = siteHead(data.site, { isAdmin: data.isAdmin, sortControl: sortToggle });`
to:

```ts
  const head = siteHead(data.site, {
    isAdmin: data.isAdmin,
    listControls: `${sortToggle}${renderSearchForm()}`
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/templates/layout.test.ts test/templates/index.test.ts`
Expected: PASS. Also run `npm run typecheck` (expected: clean — confirms no remaining `sortControl` references).

- [ ] **Step 5: Commit**

```bash
git add src/templates/layout.ts src/templates/index.ts test/templates/layout.test.ts test/templates/index.test.ts
git commit -m "feat(search): merged listControls header slot + search form"
```

---

### Task 6: Search results template — `src/templates/search.ts`

**Files:**
- Create: `src/templates/search.ts`
- Test: `test/templates/search.test.ts`

- [ ] **Step 1: Write the failing test**

`test/templates/search.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderSearchPage } from '../../src/templates/search.ts';

const base = { site: { title: 'rkroll' } } as const;

test('prompt state when no query', () => {
  const html = renderSearchPage({ ...base, q: '', results: [] });
  assert.match(html, /Type a query/);
  assert.match(html, /<form[^>]*action="\/search"/); // search box present
  assert.doesNotMatch(html, /class="rkr-sort-toggle"/); // no sort toggle here
});

test('no-results state echoes the escaped query', () => {
  const html = renderSearchPage({ ...base, q: '<x>', results: [] });
  assert.match(html, /No results for/);
  assert.match(html, /&lt;x&gt;/);
});

test('renders hits with title link, date, and snippet HTML', () => {
  const html = renderSearchPage({
    ...base,
    q: 'rust',
    results: [
      { slug: 'a', title: 'Alpha', date: '2026-05-01', snippetHtml: 'pre <mark>rust</mark> post' }
    ]
  });
  assert.match(html, /<a href="\/a">Alpha<\/a>/);
  assert.match(html, /<time[^>]*>2026-05-01<\/time>/);
  assert.match(html, /<mark>rust<\/mark>/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/templates/search.test.ts`
Expected: FAIL — cannot find module `search.ts`.

- [ ] **Step 3: Implement**

`src/templates/search.ts`:

```ts
// Search results page. Reuses the .post-list chrome; adds a snippet
// line per hit. Header shows the search form only (no sort toggle —
// results are relevance-ranked, not date-ordered).

import { escapeAttr, escapeText } from '../lib/content.ts';
import {
  bundleVersion,
  renderSearchForm,
  type SiteChrome,
  siteFoot,
  siteHead,
  stylesheetLinks
} from './layout.ts';

export interface SearchHit {
  slug: string;
  title: string;
  date?: string;
  /** Trusted, pre-sanitized HTML: escaped snippet text with <mark> spans. */
  snippetHtml: string;
}

export interface SearchPageData extends SiteChrome {
  q: string;
  results: SearchHit[];
  isAdmin?: boolean;
}

export function renderSearchPage(data: SearchPageData): string {
  const v = bundleVersion();
  const head = siteHead(data.site, {
    isAdmin: data.isAdmin,
    listControls: renderSearchForm(data.q)
  });
  const trimmed = data.q.trim();

  let bodyHtml: string;
  if (trimmed === '') {
    bodyHtml = `<p class="rkr-search-empty">Type a query to search posts.</p>`;
  } else if (data.results.length === 0) {
    bodyHtml = `<p class="rkr-search-empty">No results for “${escapeText(data.q)}”.</p>`;
  } else {
    const items = data.results
      .map((r) => {
        const dateBlock = r.date
          ? `<time datetime="${escapeAttr(r.date)}">${escapeText(r.date)}</time>`
          : '';
        return `  <li><a href="/${escapeAttr(r.slug)}">${escapeText(r.title)}</a>${dateBlock}<p class="rkr-search-snippet">${r.snippetHtml}</p></li>`;
      })
      .join('\n');
    bodyHtml = `<ul class="post-list rkr-search-results">\n${items}\n</ul>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Search — ${escapeText(data.site.title)}</title>
${stylesheetLinks()}
<link rel="manifest" href="/static/manifest.webmanifest"/>
<meta name="theme-color" content="#1a4f7f"/>
<script type="module" src="/static/site/sw-register.js${v}" defer></script>
</head>
<body>
${head}<main id="main" tabindex="-1">
<div class="rkr-index-layout">
<div class="rkr-index-posts">
<h1 class="rkr-index-heading">Search</h1>
${bodyHtml}
</div>
</div>
</main>
${siteFoot(data.site, { isAdmin: data.isAdmin })}
</body>
</html>
`;
}
```

If `SiteChrome` / `siteFoot` / `stylesheetLinks` / `bundleVersion`
export names differ, match `src/templates/index.ts`'s imports from
`./layout.ts` exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/templates/search.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/templates/search.ts test/templates/search.test.ts
git commit -m "feat(search): search results page template"
```

---

### Task 7: Route — `GET /search`

**Files:**
- Modify: `src/routes/public.ts`
- Test: `test/routes/search.test.ts`

- [ ] **Step 1: Write the failing test**

`test/routes/search.test.ts` — model the harness on `test/routes/public.test.ts`'s `setup(t)` (build the Fastify app against a temp `SITE_ROOT`, seed posts, `runReindex`, `app.inject`). Concretely:

```ts
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildApp } from '../../src/server.ts';
import { runReindex } from '../../src/cli/reindex.ts';

function seed(root: string, file: string, slug: string, title: string, status: string, body: string) {
  fs.writeFileSync(
    path.join(root, 'content', 'posts', file),
    `---\nslug: ${slug}\ntitle: ${title}\nstatus: ${status}\ndate: 2026-05-01\n---\n\n${body}\n`
  );
}

async function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-search-'));
  for (const s of ['content/posts', 'data']) fs.mkdirSync(path.join(root, s), { recursive: true });
  seed(root, 'pub.md', 'pub', 'Rust Async', 'published', 'tokio runtime details here');
  seed(root, 'draft.md', 'draft', 'Secret Draft', 'draft', 'tokio draft only');
  runReindex(root);
  const app = await buildApp({ siteRoot: root });
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, root };
}

test('GET /search with no q renders the prompt state', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/search' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Type a query/);
});

test('anonymous search returns published hits with a <mark> snippet, not drafts', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/search?q=tokio' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<a href="\/pub">Rust Async<\/a>/);
  assert.match(res.body, /<mark>/);
  assert.doesNotMatch(res.body, /Secret Draft/);
});

test('query is HTML-escaped (no XSS via q)', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: `/search?q=${encodeURIComponent('<script>x</script>')}`
  });
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body, /<script>x<\/script>/);
});
```

Match `buildApp`'s real export/signature to `test/routes/public.test.ts` (use the exact builder + options that file uses; adjust the import and `setup` accordingly).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/routes/search.test.ts`
Expected: FAIL — `GET /search` 404 / route not registered.

- [ ] **Step 3: Implement the route**

In `src/routes/public.ts`:

1. Add imports (match existing import grouping/order; biome will reorder on commit):

```ts
import { buildFtsMatch } from '../lib/search-query.ts';
import { renderSearchPage, type SearchHit } from '../templates/search.ts';
```

2. Register the route alongside the other public `fastify.get(...)`
handlers (use the same `db`/`isAdmin` access pattern the file already
uses for `/` — `const isAdmin = !!req.user;`, the route's `db` handle):

```ts
fastify.get<{ Querystring: { q?: string } }>('/search', async (req, reply) => {
  const isAdmin = !!req.user;
  const site = getSite();
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const match = buildFtsMatch(q);

  let results: SearchHit[] = [];
  if (match) {
    try {
      const rows = db
        .prepare<{ slug: string; title: string; published_at: string | null; snip: string }>(
          `SELECT p.slug AS slug, p.title AS title, p.published_at AS published_at,
                  snippet(posts_fts, 3, char(1), char(2), '…', 12) AS snip
             FROM posts_fts
             JOIN posts p ON p.slug = posts_fts.slug
            WHERE posts_fts MATCH ?
              AND (p.status = 'published' OR ? = 1)
            ORDER BY bm25(posts_fts, 0.0, 10.0, 5.0, 1.0)
            LIMIT 50`
        )
        .all(match, isAdmin ? 1 : 0);
      results = rows.map((r) => ({
        slug: r.slug,
        title: r.title,
        ...(r.published_at ? { date: r.published_at.slice(0, 10) } : {}),
        snippetHtml: highlightSnippet(r.snip)
      }));
    } catch {
      // posts_fts absent (DB not yet migrated in this process) →
      // degrade to empty results rather than 500.
      results = [];
    }
  }

  setPublicSecurityHeaders(reply);
  if (isAdmin) reply.header('Cache-Control', 'private, no-store');
  return reply
    .type('text/html; charset=utf-8')
    .send(renderSearchPage({ site, q, results, isAdmin }));
});
```

Use whatever helper this file already calls on `/` for security
headers (e.g. `setPublicSecurityHeaders`); if the name differs, copy
the exact call `/` uses. `getSite()` and `db` are already in scope in
this module (same as the `/` handler).

3. Add the snippet highlighter near the other module-private helpers
(`escapeText` is imported from `../lib/content.ts`; confirm and reuse):

```ts
// snippet() wraps matches in sentinel chars (from the SQL
// char(1)/char(2) args = U+0001 / U+0002). Escape the whole string
// FIRST, THEN swap the (escaping-untouched) sentinels for <mark> — a
// literal "<mark>" in body text cannot be injected.
const SNIP_OPEN = String.fromCharCode(1);
const SNIP_CLOSE = String.fromCharCode(2);
function highlightSnippet(snip: string): string {
  return escapeText(snip)
    .split(SNIP_OPEN)
    .join('<mark>')
    .split(SNIP_CLOSE)
    .join('</mark>');
}
```

If `escapeText` is not already imported in `public.ts`, add it to the
existing `../lib/content.ts` import.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types test/routes/search.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/public.ts test/routes/search.test.ts
git commit -m "feat(search): GET /search route with scoped, escaped results"
```

---

### Task 8: Header search-box styling (focus-expand)

**Files:**
- Modify: `static/themes/default.css`

- [ ] **Step 1: Add the CSS**

Append near the other `.rkr-site-head-*` rules in
`static/themes/default.css`:

```css
/* Header search: collapsed by default, widens on focus. Pure CSS;
   the form is a no-JS GET form. */
.rkr-site-search { display: inline-flex; margin: 0; }
.rkr-site-search input {
  width: 9rem;
  font: inherit;
  font-size: 0.85rem;
  color: var(--rkr-text);
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--rkr-rule);
  padding: 0.15rem 0.25rem;
  transition: width 160ms ease, border-color 160ms ease;
}
.rkr-site-search input::placeholder { color: var(--rkr-muted); }
.rkr-site-search input:focus {
  width: 18rem;
  outline: none;
  border-bottom-color: var(--rkr-link);
}
@media (max-width: 640px) {
  .rkr-site-search input { width: 7rem; }
  .rkr-site-search input:focus { width: 11rem; }
}
```

- [ ] **Step 2: Visually verify with the harness**

Render the index + `/search` via the local harness pattern
(`/tmp/...` gen.mjs serving `/static/` from the repo + a generated
page) and screenshot at 1280-wide with headless chromium; confirm: the
search box sits between the sort toggle and Home, collapsed, and
widens on focus (screenshot a `:focus` state via `autofocus` on a test
copy if needed). No automated test (pure presentational); the
template tests already assert the form/markup exists.

- [ ] **Step 3: Commit**

```bash
git add static/themes/default.css
git commit -m "style(search): header search box, focus-expand"
```

---

### Task 9: Full gate, push, deploy

- [ ] **Step 1: Run the full gate**

Run: `npm run typecheck` then
`node --test --no-warnings=ExperimentalWarning --experimental-strip-types 'test/**/*.test.ts'` then `npm run lint`
Expected: typecheck clean, all tests pass, biome clean.

- [ ] **Step 2: Final verification & push**

```bash
git status --porcelain   # only expected files; .claude/worktrees ignored
git push
```

(The pre-commit gauntlet — biome/tsc/coverage/etc. — has gated every
task commit; a clean `git push` means HEAD is green.)

- [ ] **Step 3: Deploy**

```bash
deploy.sh update .
```

Then verify: `curl -sS -o /dev/null -w "%{http_code}" https://rkr-blog.rkroll.com/search?q=test` → `200`, and the served `default.css` contains `.rkr-site-search`.

---

## Self-Review

**Spec coverage:**
- §1 schema → Task 1. §2 extractor → Task 2. §3 reindex → Task 4. §4 query builder → Task 3. §5 route (scope, snippet escaping, defensive try/catch, cache headers) → Task 7. §6 merged `listControls` + search form + results template + CSS → Tasks 5, 6, 8. §7 edge cases → covered across Tasks 3 (empty/punct/cap), 6 (empty/no-result states), 7 (escaping, missing-table guard). §8 testing → each task is TDD; Task 9 runs the full gate. §9 YAGNI — no pagination/typeahead/etc. introduced. No gaps.

**Placeholder scan:** No TBD/TODO; every code/SQL step is concrete. The few "match the existing export/helper name" notes are deliberate guards against drift in files not fully quoted here, not missing content.

**Type consistency:** `extractPlainText(ast: Root): string` (Task 2) is consumed in Task 4. `buildFtsMatch(raw): string | null` (Task 3) consumed in Task 7. `renderSearchForm(q?)` (Task 5) consumed in Tasks 5 (index) & 6 (search page). `SearchHit`/`SearchPageData`/`renderSearchPage` (Task 6) consumed in Task 7. `listControls` replaces `sortControl` consistently in Task 5 (layout + index) — Task 7's search route uses the template, not the slot directly. bm25 weight list is 4 args (slug/title/tags/body) matching the 4 FTS columns; `snippet(posts_fts, 3, …)` targets column index 3 = `body`. Consistent.
