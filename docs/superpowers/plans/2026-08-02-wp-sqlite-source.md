# WordPress SQLite-backup source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the `site-admin` importer read posts, pages, comments and images from a WordPress database dump plus its on-disk uploads tree, so content the WP REST API can no longer reach can still be imported and pushed.

**Architecture:** A `WpSource` interface abstracts "where WP content comes from". Two implementations: `restSource()` wraps the existing `lib/wp-rest.ts` functions unchanged; `sqliteSource()` reads a converted dump plus `wp-content/uploads/`. `importPost` and `pushPost` already accept injectable `fetchImage` / `fetchTagNames`, so the emit pipeline is untouched. A separate `wp-dump` command converts `mariadb-dump` output to SQLite.

**Tech Stack:** TypeScript ESM with `--experimental-strip-types` (no build step for `src/`), `node:sqlite` via `src/lib/db.ts`, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-02-wp-sqlite-source-design.md`

## Global Constraints

- ES modules, `.ts` extensions in import specifiers, kebab-case filenames, no top-level side effects (`docs/developer-quickstart.md §4`).
- Production source under `src/` and `bin/` is capped at 500 lines per file. Tests are exempt.
- No re-export modules — the `no-reexports` gate rejects them. Import from the defining module.
- Coverage gate is **per-file**: lines ≥ 90%, branches ≥ 75%, functions ≥ 90% (`npm run test:coverage`). Production-only wiring that tests cannot reach uses the existing `/* c8 ignore start */ … /* c8 ignore stop */` pattern with a reason comment.
- `knip:gate` rejects unused exports. Every new export must have a consumer.
- Run the full gauntlet via the pre-commit hook. Do not use `--no-verify`.
- Test command for one file: `npm test -- test/lib/<name>.test.ts` — or directly:
  `node --test --no-warnings=ExperimentalWarning --experimental-strip-types --conditions=development test/lib/<name>.test.ts`
- Real backup fixtures live at `../roll-along/db/rollalong.sql` and `../roll-along/site/wp-content/uploads/`. These are **read-only** — never write into that tree.

## File Structure

**Create:**
- `src/lib/wp-dump.ts` — mysqldump → SQLite converter (~250 lines)
- `src/cli/wp-dump.ts` — `site-admin wp-dump <dump.sql> <out.db>` (~45 lines)
- `src/lib/wp-source.ts` — `WpSource` interface + `restSource()` (~110 lines)
- `src/lib/wp-sqlite-images.ts` — `sqliteImageFetcher()` (~95 lines)
- `src/lib/wp-sqlite.ts` — `sqliteSource()` (~240 lines)
- `test/lib/wp-dump.test.ts`, `test/lib/wp-source.test.ts`, `test/lib/wp-sqlite-images.test.ts`, `test/lib/wp-sqlite.test.ts`, `test/lib/wp-sqlite-backup.test.ts`

**Modify:**
- `src/lib/wp-import-types.ts` — home for `ListResult`, `CommentListResult`, `WpSiteInfo`, `WpFetcher`
- `src/lib/wp-rest.ts` — import those types instead of declaring them
- `src/lib/wp-import.ts` — export `defaultImageFetcher` / `defaultTagFetcher` for `restSource`
- `src/lib/wp-push.ts` — accept an injected `WpSource`
- `src/cli/import-wp.ts` — `--from-dump` / `--uploads` flags
- `src/cli/import-wp-comments.ts` — same flags
- `bin/site-admin` — register `wp-dump`
- `docs/RUNBOOK.md`, `docs/spec.md` — document the flags and the new command

---

### Task 1: mysqldump → SQLite converter

**Files:**
- Create: `src/lib/wp-dump.ts`
- Test: `test/lib/wp-dump.test.ts`

**Model:** `opus` — the SQL tokenizer has subtle quoting/escaping edge cases where a silent bug corrupts imported content.

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `convertDump(sqlPath: string, dbPath: string): DumpStats` where
  `interface DumpStats { tables: number; rows: number }`.

- [ ] **Step 1: Write the failing test**

Create `test/lib/wp-dump.test.ts`:

```ts
// Coverage for the mysqldump → SQLite converter. Each test writes a
// small .sql fixture, converts it, and queries the result.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { convertDump } from '../../src/lib/wp-dump.ts';

function tmpdir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-wp-dump-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function convert(t: TestContext, sql: string) {
  const dir = tmpdir(t);
  const sqlPath = path.join(dir, 'dump.sql');
  const dbPath = path.join(dir, 'out.db');
  fs.writeFileSync(sqlPath, sql);
  const stats = convertDump(sqlPath, dbPath);
  const db = open(dbPath);
  t.after(() => db.close());
  return { db, stats };
}

const POSTS_DDL = `
DROP TABLE IF EXISTS \`wp_posts\`;
CREATE TABLE \`wp_posts\` (
  \`ID\` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  \`post_title\` text NOT NULL,
  \`post_content\` longtext NOT NULL,
  \`menu_order\` int(11) NOT NULL DEFAULT 0,
  \`ratio\` double DEFAULT NULL,
  PRIMARY KEY (\`ID\`),
  KEY \`type_status_date\` (\`post_title\`(20))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

test('convertDump: maps MySQL types and drops index clauses', (t) => {
  const { db, stats } = convert(t, `${POSTS_DDL}
INSERT INTO \`wp_posts\` VALUES (1,'Hello','<p>Hi</p>',0,1.5);
`);
  assert.equal(stats.tables, 1);
  assert.equal(stats.rows, 1);
  const cols = db.prepare<{ name: string; type: string }>('PRAGMA table_info(wp_posts)').all();
  assert.deepEqual(
    cols.map((c) => [c.name, c.type]),
    [
      ['ID', 'INTEGER'],
      ['post_title', 'TEXT'],
      ['post_content', 'TEXT'],
      ['menu_order', 'INTEGER'],
      ['ratio', 'REAL']
    ]
  );
});

test('convertDump: handles escapes, embedded delimiters and NULL', (t) => {
  const { db, stats } = convert(t, `${POSTS_DDL}
INSERT INTO \`wp_posts\` VALUES (1,'It\\'s a (test); ok','line1\\nline2',0,NULL),(2,'quote '' here','back\\\\slash',3,2.5);
`);
  assert.equal(stats.rows, 2);
  const rows = db
    .prepare<{ ID: number; post_title: string; post_content: string; ratio: number | null }>(
      'SELECT ID, post_title, post_content, ratio FROM wp_posts ORDER BY ID'
    )
    .all();
  assert.equal(rows[0]?.post_title, "It's a (test); ok");
  assert.equal(rows[0]?.post_content, 'line1\nline2');
  assert.equal(rows[0]?.ratio, null);
  assert.equal(rows[1]?.post_title, "quote ' here");
  assert.equal(rows[1]?.post_content, 'back\\slash');
  assert.equal(rows[1]?.ratio, 2.5);
});

test('convertDump: ignores comments, conditional directives and other statements', (t) => {
  const { db, stats } = convert(t, `
/*!40101 SET NAMES utf8mb4 */;
-- a comment with a ; semicolon
LOCK TABLES \`wp_posts\` WRITE;
${POSTS_DDL}
INSERT INTO \`wp_posts\` (\`ID\`,\`post_title\`,\`post_content\`,\`menu_order\`,\`ratio\`) VALUES (7,'T','C',0,NULL);
UNLOCK TABLES;
`);
  assert.equal(stats.tables, 1);
  assert.equal(stats.rows, 1);
  const row = db.prepare<{ ID: number }>('SELECT ID FROM wp_posts').get();
  assert.equal(row?.ID, 7);
});

test('convertDump: is idempotent over repeated runs', (t) => {
  const dir = tmpdir(t);
  const sqlPath = path.join(dir, 'dump.sql');
  const dbPath = path.join(dir, 'out.db');
  fs.writeFileSync(sqlPath, `${POSTS_DDL}\nINSERT INTO \`wp_posts\` VALUES (1,'A','B',0,NULL);\n`);
  convertDump(sqlPath, dbPath);
  const stats = convertDump(sqlPath, dbPath);
  assert.equal(stats.rows, 1);
  const db = open(dbPath);
  t.after(() => db.close());
  const n = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM wp_posts').get();
  assert.equal(n?.n, 1);
});

test('convertDump: throws when the dump has no CREATE TABLE', (t) => {
  const dir = tmpdir(t);
  const sqlPath = path.join(dir, 'dump.sql');
  fs.writeFileSync(sqlPath, '-- nothing here\n');
  assert.throws(() => convertDump(sqlPath, path.join(dir, 'out.db')), /no CREATE TABLE/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types --conditions=development test/lib/wp-dump.test.ts`
Expected: FAIL — `Cannot find module '.../src/lib/wp-dump.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/wp-dump.ts`:

```ts
// mysqldump / mariadb-dump → SQLite. Converts the subset of SQL a
// WordPress dump contains so the importer can read a backup offline
// (lib/wp-sqlite.ts). Not a general-purpose MySQL parser: it handles
// CREATE TABLE with backtick identifiers and multi-row INSERT ... VALUES,
// and ignores everything else.

import fs from 'node:fs';

import { open } from './db.ts';

export interface DumpStats {
  tables: number;
  rows: number;
}

const TYPE_MAP: Array<[RegExp, string]> = [
  [/\b(tinyint|smallint|mediumint|bigint|int)\b/i, 'INTEGER'],
  [/\b(double|float|decimal|numeric)\b/i, 'REAL'],
  [/\b(blob|binary|varbinary)\b/i, 'BLOB']
];

function sqliteType(mysqlType: string): string {
  for (const [pattern, out] of TYPE_MAP) if (pattern.test(mysqlType)) return out;
  return 'TEXT';
}

/** Split SQL into top-level statements, respecting ' " ` quoting and
 * backslash escapes so a `;` inside a string literal doesn't split. */
function* statements(text: string): Generator<string> {
  let buf = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    buf += c;
    if (quote) {
      if (c === '\\' && quote !== '`') {
        i++;
        if (i < text.length) buf += text[i];
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === ';') {
      yield buf;
      buf = '';
    }
  }
  if (buf.trim()) yield buf;
}

/** Split a CREATE TABLE body on top-level commas (not inside parens or
 * quotes) so `decimal(10,2)` and `KEY x (a,b)` stay intact. */
function splitColumns(body: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (quote) {
      cur += c;
      if (c === '\\' && quote !== '`') {
        i++;
        if (i < body.length) cur += body[i];
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '`') {
      quote = c;
      cur += c;
    } else if (c === '(') {
      depth++;
      cur += c;
    } else if (c === ')') {
      depth--;
      cur += c;
    } else if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const SKIP_CLAUSE = /^(primary\s+key|unique\s+key|fulltext\s+key|spatial\s+key|key|index|constraint|foreign\s+key)\b/i;

/** Translate one CREATE TABLE statement. Returns null if it isn't one. */
function convertCreate(stmt: string): { table: string; ddl: string } | null {
  const m = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?`([^`]+)`\s*\(([\s\S]*)\)[^)]*$/i.exec(stmt);
  if (!m) return null;
  const table = m[1] as string;
  const defs: string[] = [];
  let primaryKey: string[] = [];
  for (const col of splitColumns(m[2] as string)) {
    if (/^primary\s+key/i.test(col)) {
      primaryKey = Array.from(col.matchAll(/`([^`]+)`/g), (g) => g[1] as string);
      continue;
    }
    if (SKIP_CLAUSE.test(col)) continue;
    const cm = /^`([^`]+)`\s+([\s\S]*)$/.exec(col);
    if (!cm) continue;
    defs.push(`\`${cm[1]}\` ${sqliteType(cm[2] as string)}`);
  }
  if (primaryKey.length > 0) {
    defs.push(`PRIMARY KEY (${primaryKey.map((k) => `\`${k}\``).join(', ')})`);
  }
  return { table, ddl: `CREATE TABLE \`${table}\` (\n  ${defs.join(',\n  ')}\n)` };
}

const UNESCAPE: Record<string, string> = {
  '0': '\0',
  b: '\b',
  n: '\n',
  r: '\r',
  t: '\t',
  Z: '\x1a',
  '\\': '\\',
  "'": "'",
  '"': '"'
};

type Cell = string | number | null;

/** Parse `(a,b),(c,d)` into rows of JS values. Quoted fields stay
 * strings; bare NULL becomes null; bare numerics become numbers. */
function parseValues(text: string): Cell[][] {
  const rows: Cell[][] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && ' \t\r\n,'.includes(text[i] as string)) i++;
    if (text[i] !== '(') break;
    i++;
    const row: Cell[] = [];
    let field = '';
    let quoted = false;
    while (i < text.length) {
      const c = text[i] as string;
      if (c === "'") {
        quoted = true;
        i++;
        while (i < text.length) {
          const ch = text[i] as string;
          if (ch === '\\') {
            i++;
            const esc = text[i] as string;
            field += UNESCAPE[esc] ?? esc;
          } else if (ch === "'") {
            if (text[i + 1] === "'") {
              field += "'";
              i++;
            } else break;
          } else field += ch;
          i++;
        }
        i++;
      } else if (c === ',' || c === ')') {
        row.push(quoted ? field : bareValue(field));
        field = '';
        quoted = false;
        i++;
        if (c === ')') break;
      } else {
        field += c;
        i++;
      }
    }
    rows.push(row);
  }
  return rows;
}

function bareValue(raw: string): Cell {
  const tok = raw.trim();
  if (tok.toUpperCase() === 'NULL' || tok === '') return null;
  if (/^-?\d+$/.test(tok)) return Number(tok);
  if (/^-?[\d.]+(e[-+]?\d+)?$/i.test(tok)) return Number(tok);
  return tok;
}

/** Convert a dump file into a fresh SQLite database at `dbPath`.
 * Existing tables of the same name are dropped, so repeat runs are
 * idempotent. */
export function convertDump(sqlPath: string, dbPath: string): DumpStats {
  const text = fs.readFileSync(sqlPath, 'utf8');
  const db = open(dbPath);
  let tables = 0;
  let rows = 0;
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    for (const stmt of statements(text)) {
      const s = stmt.trim();
      if (!s || s.startsWith('--')) continue;
      if (/^CREATE TABLE/i.test(s)) {
        const created = convertCreate(s);
        if (!created) continue;
        db.exec(`DROP TABLE IF EXISTS \`${created.table}\``);
        db.exec(created.ddl);
        tables++;
      } else if (/^INSERT INTO/i.test(s)) {
        const m = /^INSERT INTO\s+`([^`]+)`\s*(?:\([^)]*\))?\s*VALUES\s*([\s\S]*?);?\s*$/i.exec(s);
        if (!m) continue;
        const parsed = parseValues(m[2] as string);
        if (parsed.length === 0) continue;
        const placeholders = (parsed[0] as Cell[]).map(() => '?').join(',');
        const insert = db.prepare(`INSERT INTO \`${m[1]}\` VALUES (${placeholders})`);
        db.transaction(() => {
          for (const row of parsed) insert.run(...row);
        })();
        rows += parsed.length;
      }
    }
  } finally {
    db.close();
  }
  if (tables === 0) throw new Error(`no CREATE TABLE statements in ${sqlPath}`);
  return { tables, rows };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types --conditions=development test/lib/wp-dump.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Add the CLI command**

Create `src/cli/wp-dump.ts`:

```ts
// `site-admin wp-dump <dump.sql> <out.db>` — convert a mysqldump /
// mariadb-dump file into a SQLite database the importer can read
// (`import-wp --from-dump`). One-shot and idempotent.

import { convertDump } from '../lib/wp-dump.ts';

export default async function wpDumpCmd(argv: string[]): Promise<void> {
  const sqlPath = argv[0];
  const dbPath = argv[1];
  if (!sqlPath || !dbPath) {
    throw new Error('usage: site-admin wp-dump <dump.sql> <out.db>');
  }
  const stats = convertDump(sqlPath, dbPath);
  console.log(`${stats.tables} tables, ${stats.rows} rows → ${dbPath}`);
}
```

Modify `bin/site-admin`, adding to the `COMMANDS` map after the `import-wp` entries:

```js
  'wp-dump':            () => import('../src/cli/wp-dump.ts'),
```

- [ ] **Step 6: Verify the CLI against the real dump**

Run:
```bash
node --no-warnings=ExperimentalWarning --experimental-strip-types bin/site-admin \
  wp-dump ../roll-along/db/rollalong.sql /tmp/rollalong.db
```
Expected: `15 tables, 8974 rows → /tmp/rollalong.db`

Then confirm the post counts match the source:
```bash
sqlite3 /tmp/rollalong.db "select post_status, count(*) from wp_posts where post_type='post' group by 1;"
```
Expected: `auto-draft|3`, `draft|3`, `publish|65`

- [ ] **Step 7: Commit**

```bash
git add src/lib/wp-dump.ts src/cli/wp-dump.ts bin/site-admin test/lib/wp-dump.test.ts
git commit -m "feat(wp-dump): convert a mysqldump file to SQLite"
```

---

### Task 2: WpSource interface and the REST adapter

**Files:**
- Create: `src/lib/wp-source.ts`
- Modify: `src/lib/wp-import-types.ts`, `src/lib/wp-rest.ts`, `src/lib/wp-import.ts`
- Test: `test/lib/wp-source.test.ts`

**Model:** `sonnet` — mechanical extraction plus an interface definition across four files.

**Interfaces:**
- Consumes: `convertDump` is unrelated; this task depends on nothing from Task 1.
- Produces:
  - In `wp-import-types.ts`: `ListResult`, `CommentListResult`, `WpSiteInfo`, `WpFetcher` (moved from `wp-rest.ts`, identical shapes).
  - In `wp-import.ts`: `export function defaultImageFetcher(): (url: string) => Promise<Readable>` and `export function defaultTagFetcher(): (tagIds: number[], postLink: string) => Promise<string[]>` (existing private functions, now exported).
  - In `wp-source.ts`: the `WpSource` interface and `restSource(baseUrl: string, fetcher?: WpFetcher): WpSource`.

- [ ] **Step 1: Move the shared types**

In `src/lib/wp-import-types.ts`, append:

```ts
/** Fetcher signature used by the REST client and its tests. */
export type WpFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ListResult {
  posts: WpPost[];
  total: number;
  totalPages: number;
}

export interface CommentListResult {
  comments: WpComment[];
  total: number;
  totalPages: number;
}

export interface WpSiteInfo {
  name: string;
  description: string;
}
```

In `src/lib/wp-rest.ts`, delete the local `ListResult`, `CommentListResult`, `WpFetcher` and `WpSiteInfo` declarations (lines 11–24 and 109–112) and extend the existing type import:

```ts
import type {
  CommentListResult,
  ListResult,
  WpComment,
  WpFetcher,
  WpPost,
  WpSiteInfo
} from './wp-import-types.ts';
```

Update the four test files that import `WpFetcher` from `wp-rest.ts` to import it from `wp-import-types.ts` instead: `test/lib/wp-rest-comments.test.ts:3`, `test/lib/wp-rest-pages.test.ts:3`, `test/cli/import-wp-comments.test.ts:10`, and `src/cli/import-wp-comments.ts:11` (which imports `type WpFetcher` alongside its value imports — split the type import out).

- [ ] **Step 2: Export the default fetchers**

In `src/lib/wp-import.ts`, change the two function declarations at lines 184 and 195 from `function` to `export function`. Leave the surrounding `/* c8 ignore start */` … `/* c8 ignore stop */` markers in place, and update the comment above them to read:

```ts
/* c8 ignore start -- production-only wiring; tests inject their own fetchers */
```

- [ ] **Step 3: Write the failing test**

Create `test/lib/wp-source.test.ts`:

```ts
// restSource: the WpSource adapter over the REST client. A loopback
// fetcher stands in for a live WordPress install.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WpFetcher } from '../../src/lib/wp-import-types.ts';
import { restSource } from '../../src/lib/wp-source.ts';

function stubFetcher(routes: Record<string, unknown>): WpFetcher {
  return async (url) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' }
    });
  };
}

const POST = {
  id: 5,
  date: '2020-01-02T03:04:05',
  modified: '2020-01-02T03:04:05',
  slug: 'hello',
  status: 'publish',
  title: { rendered: 'Hello' },
  content: { rendered: '<p>Hi</p>' },
  excerpt: { rendered: '' },
  link: 'https://wp.example/hello'
};

test('restSource: listPosts and fetchPost delegate to the REST client', async () => {
  const src = restSource('https://wp.example', stubFetcher({ '/wp/v2/posts': [POST] }));
  const list = await src.listPosts({ perPage: 10 });
  assert.equal(list.total, 1);
  assert.equal(list.posts[0]?.slug, 'hello');
  const one = await src.fetchPost('hello');
  assert.equal(one.id, 5);
  src.close();
});

test('restSource: fetchSiteInfo reads the REST root', async () => {
  const src = restSource(
    'https://wp.example',
    stubFetcher({ '/wp-json/': { name: 'Blog', description: 'Tag' } })
  );
  const info = await src.fetchSiteInfo();
  assert.deepEqual(info, { name: 'Blog', description: 'Tag' });
  src.close();
});

test('restSource: fetchFeaturedMediaUrl returns null for media id 0', async () => {
  const src = restSource('https://wp.example', stubFetcher({}));
  assert.equal(await src.fetchFeaturedMediaUrl(0), null);
  src.close();
});

test('restSource: listComments delegates to the REST client', async () => {
  const comment = {
    id: 1,
    post: 5,
    parent: 0,
    author_name: 'A',
    author_url: '',
    date: '2020-01-02T00:00:00',
    content: { rendered: '<p>hi</p>' }
  };
  const src = restSource('https://wp.example', stubFetcher({ '/wp/v2/comments': [comment] }));
  const r = await src.listComments({ perPage: 10 });
  assert.equal(r.comments[0]?.author_name, 'A');
  src.close();
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types --conditions=development test/lib/wp-source.test.ts`
Expected: FAIL — `Cannot find module '.../src/lib/wp-source.ts'`

- [ ] **Step 5: Write the implementation**

Create `src/lib/wp-source.ts`:

```ts
// Where WP content comes from. `restSource` reads a live install over
// its REST API (lib/wp-rest.ts); `sqliteSource` (lib/wp-sqlite.ts)
// reads a converted database dump plus the uploads tree. The CLI picks
// one and the rest of the import pipeline is unaware of the difference.

import type { Readable } from 'node:stream';

import { defaultImageFetcher, defaultTagFetcher } from './wp-import.ts';
import type {
  CommentListResult,
  ListResult,
  WpFetcher,
  WpPost,
  WpSiteInfo
} from './wp-import-types.ts';
import {
  fetchFeaturedMediaUrl,
  fetchPost,
  fetchWpPage,
  fetchWpSiteBannerUrl,
  fetchWpSiteInfo,
  listComments,
  listPosts
} from './wp-rest.ts';

export interface ListPostsOpts {
  page?: number;
  perPage?: number;
  /** WP status: `publish`, `draft`, or `any`. */
  status?: string;
}

export interface ListCommentsOpts {
  page?: number;
  perPage?: number;
}

export interface WpSource {
  listPosts(opts?: ListPostsOpts): Promise<ListResult>;
  fetchPost(idOrSlug: string | number): Promise<WpPost>;
  fetchPage(slug: string): Promise<WpPost>;
  fetchSiteInfo(): Promise<WpSiteInfo>;
  fetchSiteBannerUrl(): Promise<string | null>;
  fetchFeaturedMediaUrl(mediaId: number): Promise<string | null>;
  listComments(opts?: ListCommentsOpts): Promise<CommentListResult>;
  /** Passed to importPost as `opts.fetchImage`. */
  fetchImage(url: string): Promise<Readable>;
  /** Passed to importPost as `opts.fetchTagNames`. */
  fetchTagNames(tagIds: number[], postLink: string): Promise<string[]>;
  /** Release resources (a database handle for the SQLite source; a
   * no-op for REST). */
  close(): void;
}

/** WP content over the REST API of a live install. */
export function restSource(baseUrl: string, fetcher?: WpFetcher): WpSource {
  const args = fetcher ? ([fetcher] as const) : ([] as const);
  const image = defaultImageFetcher();
  const tags = defaultTagFetcher();
  return {
    listPosts: (opts = {}) => listPosts(baseUrl, opts, ...args),
    fetchPost: (idOrSlug) => fetchPost(baseUrl, idOrSlug, ...args),
    fetchPage: (slug) => fetchWpPage(baseUrl, slug, ...args),
    fetchSiteInfo: () => fetchWpSiteInfo(baseUrl, ...args),
    fetchSiteBannerUrl: () => fetchWpSiteBannerUrl(baseUrl, ...args),
    fetchFeaturedMediaUrl: (mediaId) => fetchFeaturedMediaUrl(baseUrl, mediaId, ...args),
    listComments: (opts = {}) => listComments(baseUrl, opts, ...args),
    fetchImage: (url) => image(url),
    fetchTagNames: (tagIds, postLink) => tags(tagIds, postLink),
    close: () => {}
  };
}
```

- [ ] **Step 6: Run the full unit suite**

Run: `npm test`
Expected: PASS — the type move and the two new exports must not break any existing test.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/wp-source.ts src/lib/wp-import-types.ts src/lib/wp-rest.ts src/lib/wp-import.ts \
        src/cli/import-wp-comments.ts test/lib/wp-source.test.ts test/lib/wp-rest-comments.test.ts \
        test/lib/wp-rest-pages.test.ts test/cli/import-wp-comments.test.ts
git commit -m "refactor(wp): introduce WpSource with a REST adapter"
```

---

### Task 3: Local image fetcher over the uploads tree

**Files:**
- Create: `src/lib/wp-sqlite-images.ts`
- Test: `test/lib/wp-sqlite-images.test.ts`

**Model:** `sonnet` — path resolution with a containment check; the logic is spelled out but needs care.

**Interfaces:**
- Consumes: `Db` from `src/lib/db.ts`.
- Produces: `sqliteImageFetcher(db: Db, uploadsRoot: string): (url: string) => Promise<Readable>` and `resolveAttachmentPath(db: Db, uploadsRoot: string, url: string): string | null`.

Callers pass the resolved function straight to `importPost`'s `opts.fetchImage`. The `url` argument is the `<img src>` the importer picked, optionally suffixed with `#wp-image-<id>` (Task 4 appends that fragment so the attachment id survives the trip through the emitter).

- [ ] **Step 1: Write the failing test**

Create `test/lib/wp-sqlite-images.test.ts`:

```ts
// sqliteImageFetcher: resolve a WP <img src> to a file in the backup's
// uploads tree, preferring the attachment id when the markup carries one.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { resolveAttachmentPath, sqliteImageFetcher } from '../../src/lib/wp-sqlite-images.ts';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-wp-img-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const uploads = path.join(root, 'uploads');
  fs.mkdirSync(path.join(uploads, '2026', '05'), { recursive: true });
  fs.writeFileSync(path.join(uploads, '2026', '05', 'photo.jpeg'), 'ORIGINAL');
  fs.writeFileSync(path.join(uploads, '2026', '05', 'photo-768x1024.jpeg'), 'RESIZED');
  fs.writeFileSync(path.join(root, 'outside.jpeg'), 'ESCAPED');

  const db = open(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE wp_postmeta (post_id INTEGER, meta_key TEXT, meta_value TEXT)');
  db.prepare('INSERT INTO wp_postmeta VALUES (?,?,?)').run(
    2365,
    '_wp_attached_file',
    '2026/05/photo.jpeg'
  );
  db.prepare('INSERT INTO wp_postmeta VALUES (?,?,?)').run(
    99,
    '_wp_attached_file',
    '../../outside.jpeg'
  );
  return { db, uploads };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString();
}

test('resolves via the wp-image-<id> fragment to the full-size original', async (t) => {
  const { db, uploads } = fixture(t);
  const fetchImage = sqliteImageFetcher(db, uploads);
  const stream = await fetchImage(
    'https://wp.example/wp-content/uploads/2026/05/photo-768x1024.jpeg#wp-image-2365'
  );
  assert.equal(await readAll(stream), 'ORIGINAL');
});

test('falls back to the URL path and strips the size suffix', async (t) => {
  const { db, uploads } = fixture(t);
  const fetchImage = sqliteImageFetcher(db, uploads);
  const stream = await fetchImage(
    'https://wp.example/wp-content/uploads/2026/05/photo-768x1024.jpeg'
  );
  assert.equal(await readAll(stream), 'ORIGINAL');
});

test('uses the URL path verbatim when no stripped original exists', async (t) => {
  const { db, uploads } = fixture(t);
  fs.rmSync(path.join(uploads, '2026', '05', 'photo.jpeg'));
  const fetchImage = sqliteImageFetcher(db, uploads);
  const stream = await fetchImage(
    'https://wp.example/wp-content/uploads/2026/05/photo-768x1024.jpeg'
  );
  assert.equal(await readAll(stream), 'RESIZED');
});

test('rejects an attachment path that escapes the uploads root', (t) => {
  const { db, uploads } = fixture(t);
  assert.equal(
    resolveAttachmentPath(db, uploads, 'https://wp.example/x.jpeg#wp-image-99'),
    null
  );
});

test('throws a useful error when nothing resolves', async (t) => {
  const { db, uploads } = fixture(t);
  const fetchImage = sqliteImageFetcher(db, uploads);
  await assert.rejects(
    () => fetchImage('https://wp.example/wp-content/uploads/2026/05/absent.jpeg'),
    /not in the backup/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types --conditions=development test/lib/wp-sqlite-images.test.ts`
Expected: FAIL — `Cannot find module '.../src/lib/wp-sqlite-images.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/wp-sqlite-images.ts`:

```ts
// Resolve a WordPress <img src> to a file in a backup's uploads tree.
// Preferred route is the attachment id the importer appends to the URL
// as `#wp-image-<id>`: `_wp_attached_file` names the full-size original,
// while the markup usually points at a resized variant.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { Db } from './db.ts';

interface MetaRow {
  meta_value: string;
}

/** Keep a resolved path inside `root`. `_wp_attached_file` comes from the
 * dump, so a crafted value must not be able to read outside the tree. */
function within(root: string, candidate: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

/** Path under the uploads tree for a WP image URL, or null if none
 * resolves. Tries the `#wp-image-<id>` attachment first, then the URL's
 * own path with WP's `-<W>x<H>` size suffix stripped, then verbatim. */
export function resolveAttachmentPath(db: Db, uploadsRoot: string, url: string): string | null {
  const idMatch = /#wp-image-(\d+)$/.exec(url);
  if (idMatch) {
    const row = db
      .prepare<MetaRow>(
        "SELECT meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key = '_wp_attached_file'"
      )
      .get(Number(idMatch[1]));
    if (row?.meta_value) {
      const p = within(uploadsRoot, row.meta_value);
      if (p === null) return null;
      if (fs.existsSync(p)) return p;
    }
  }

  const bare = url.replace(/#.*$/, '');
  const uploadsRel = /\/wp-content\/uploads\/(.+)$/.exec(bare)?.[1];
  if (!uploadsRel) return null;
  const decoded = decodeURIComponent(uploadsRel);

  const stripped = decoded.replace(/-\d+x\d+(\.[A-Za-z0-9]+)$/, '$1');
  for (const candidate of [stripped, decoded]) {
    const p = within(uploadsRoot, candidate);
    if (p !== null && fs.existsSync(p)) return p;
  }
  return null;
}

/** An `importPost` / `pushPost` compatible image fetcher that streams
 * from the backup's uploads tree instead of the network. */
export function sqliteImageFetcher(
  db: Db,
  uploadsRoot: string
): (url: string) => Promise<Readable> {
  return async (url: string) => {
    const file = resolveAttachmentPath(db, uploadsRoot, url);
    if (file === null) throw new Error(`image not in the backup uploads tree: ${url}`);
    return fs.createReadStream(file);
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types --conditions=development test/lib/wp-sqlite-images.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/wp-sqlite-images.ts test/lib/wp-sqlite-images.test.ts
git commit -m "feat(wp-sqlite): resolve WP image URLs against a backup uploads tree"
```

---

### Task 4: The SQLite source

**Files:**
- Create: `src/lib/wp-sqlite.ts`
- Test: `test/lib/wp-sqlite.test.ts`

**Model:** `opus` — the field mapping and slug/status semantics are where a wrong choice silently produces bad imports.

**Interfaces:**
- Consumes: `WpSource`, `ListPostsOpts`, `ListCommentsOpts` from `src/lib/wp-source.ts`; `sqliteImageFetcher` from `src/lib/wp-sqlite-images.ts`; `open` from `src/lib/db.ts`; `slugify` from `src/lib/slugify.ts`.
- Produces: `sqliteSource(opts: SqliteSourceOpts): WpSource` where
  `interface SqliteSourceOpts { dbPath: string; uploadsRoot: string }`.

Behavioral contract the CLI relies on:
- `listPosts({ status })` accepts `publish` (default), `draft`, or `any`.
- Slug resolution: `post_name` → `slugify(post_title)` → `post-<id>`.
- Every `<img>` in the returned `content.rendered` carries `#wp-image-<id>` on its `src` when the markup had a `wp-image-<id>` class, so `sqliteImageFetcher` can resolve the original.
- `listComments` returns only `comment_approved = '1'`.

- [ ] **Step 1: Write the failing test**

Create `test/lib/wp-sqlite.test.ts`:

```ts
// sqliteSource: read posts, pages, comments and site info out of a
// converted WordPress dump. Each test builds a minimal schema in a temp
// database rather than depending on the real backup.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { sqliteSource } from '../../src/lib/wp-sqlite.ts';

const SCHEMA = `
CREATE TABLE wp_posts (
  ID INTEGER PRIMARY KEY, post_author INTEGER, post_date TEXT, post_content TEXT,
  post_title TEXT, post_excerpt TEXT, post_status TEXT, post_name TEXT,
  post_modified TEXT, post_parent INTEGER, guid TEXT, post_type TEXT
);
CREATE TABLE wp_postmeta (meta_id INTEGER PRIMARY KEY, post_id INTEGER, meta_key TEXT, meta_value TEXT);
CREATE TABLE wp_terms (term_id INTEGER PRIMARY KEY, name TEXT, slug TEXT);
CREATE TABLE wp_term_taxonomy (term_taxonomy_id INTEGER PRIMARY KEY, term_id INTEGER, taxonomy TEXT);
CREATE TABLE wp_term_relationships (object_id INTEGER, term_taxonomy_id INTEGER);
CREATE TABLE wp_options (option_id INTEGER PRIMARY KEY, option_name TEXT, option_value TEXT);
CREATE TABLE wp_comments (
  comment_ID INTEGER PRIMARY KEY, comment_post_ID INTEGER, comment_author TEXT,
  comment_author_url TEXT, comment_date TEXT, comment_content TEXT,
  comment_approved TEXT, comment_parent INTEGER
);
`;

function backup(t: TestContext): { dbPath: string; uploadsRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-wp-sqlite-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'wp.db');
  const db = open(dbPath);
  db.exec(SCHEMA);

  const insertPost = db.prepare(
    'INSERT INTO wp_posts (ID, post_date, post_content, post_title, post_excerpt, post_status, post_name, post_modified, post_type) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  insertPost.run(
    10,
    '2026-05-18 21:27:39',
    '<p>Body</p><figure><img src="https://wp.example/wp-content/uploads/2026/05/p-768x1024.jpeg" class="wp-image-77"/></figure>',
    'One final day',
    'Excerpt here',
    'publish',
    'one-final-day',
    '2026-05-19 08:00:00',
    'post'
  );
  insertPost.run(
    11,
    '2026-05-19 14:49:35',
    '<p>Draft body</p>',
    'A few days in Stirling, Scotland',
    '',
    'draft',
    '',
    '2026-05-19 14:49:35',
    'post'
  );
  insertPost.run(
    12,
    '2020-01-01 00:00:00',
    '<p>About us</p>',
    'About',
    '',
    'publish',
    'about',
    '2020-01-01 00:00:00',
    'page'
  );
  insertPost.run(
    77,
    '2026-05-08 00:00:00',
    '',
    'photo',
    '',
    'inherit',
    'photo',
    '2026-05-08 00:00:00',
    'attachment'
  );

  db.prepare('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?,?,?)').run(
    10,
    '_thumbnail_id',
    '77'
  );
  db.prepare('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?,?,?)').run(
    77,
    '_wp_attached_file',
    '2026/05/p.jpeg'
  );

  db.prepare('INSERT INTO wp_terms VALUES (?,?,?)').run(1, 'Scotland', 'scotland');
  db.prepare('INSERT INTO wp_terms VALUES (?,?,?)').run(2, 'Travel', 'travel');
  db.prepare('INSERT INTO wp_term_taxonomy VALUES (?,?,?)').run(1, 1, 'post_tag');
  db.prepare('INSERT INTO wp_term_taxonomy VALUES (?,?,?)').run(2, 2, 'category');
  db.prepare('INSERT INTO wp_term_relationships VALUES (?,?)').run(10, 1);
  db.prepare('INSERT INTO wp_term_relationships VALUES (?,?)').run(10, 2);

  db.prepare('INSERT INTO wp_options (option_name, option_value) VALUES (?,?)').run(
    'blogname',
    'Roll Along'
  );
  db.prepare('INSERT INTO wp_options (option_name, option_value) VALUES (?,?)').run(
    'blogdescription',
    'A Travel Adventure'
  );
  db.prepare('INSERT INTO wp_options (option_name, option_value) VALUES (?,?)').run(
    'siteurl',
    'https://wp.example'
  );

  const insertComment = db.prepare(
    'INSERT INTO wp_comments (comment_ID, comment_post_ID, comment_author, comment_author_url, comment_date, comment_content, comment_approved, comment_parent) VALUES (?,?,?,?,?,?,?,?)'
  );
  insertComment.run(1, 10, 'Ann', '', '2026-05-19 00:00:00', 'Nice!', '1', 0);
  insertComment.run(2, 10, 'Bot', 'http://spam', '2026-05-19 00:00:00', 'Buy now', 'spam', 0);
  insertComment.run(3, 10, 'Held', '', '2026-05-19 00:00:00', 'Pending', '0', 0);

  db.close();
  const uploadsRoot = path.join(root, 'uploads');
  fs.mkdirSync(path.join(uploadsRoot, '2026', '05'), { recursive: true });
  fs.writeFileSync(path.join(uploadsRoot, '2026', '05', 'p.jpeg'), 'IMG');
  return { dbPath, uploadsRoot };
}

test('listPosts: published only by default, newest first', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const r = await src.listPosts();
  assert.equal(r.total, 1);
  assert.equal(r.totalPages, 1);
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0]?.slug, 'one-final-day');
});

test('listPosts: status draft and any', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  assert.equal((await src.listPosts({ status: 'draft' })).total, 1);
  assert.equal((await src.listPosts({ status: 'any' })).total, 2);
});

test('listPosts: paginates', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const r = await src.listPosts({ status: 'any', perPage: 1, page: 2 });
  assert.equal(r.total, 2);
  assert.equal(r.totalPages, 2);
  assert.equal(r.posts.length, 1);
});

test('fetchPost: maps every field the importer reads', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const post = await src.fetchPost('one-final-day');
  assert.equal(post.id, 10);
  assert.equal(post.title.rendered, 'One final day');
  assert.equal(post.excerpt.rendered, 'Excerpt here');
  assert.equal(post.status, 'publish');
  assert.equal(post.date, '2026-05-18T21:27:39');
  assert.equal(post.modified, '2026-05-19T08:00:00');
  assert.equal(post.link, 'https://wp.example/one-final-day');
  assert.equal(post.featured_media, 77);
  assert.deepEqual(post.tags, [1]);
  assert.deepEqual(post.categories, [2]);
});

test('fetchPost: by numeric id', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  assert.equal((await src.fetchPost(10)).slug, 'one-final-day');
});

test('fetchPost: throws for an unknown slug', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  await assert.rejects(() => src.fetchPost('nope'), /no post/);
});

test('fetchPost: annotates img src with the attachment id', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const post = await src.fetchPost('one-final-day');
  assert.match(post.content.rendered, /p-768x1024\.jpeg#wp-image-77"/);
});

test('slug falls back to the slugified title when post_name is empty', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const drafts = await src.listPosts({ status: 'draft' });
  assert.equal(drafts.posts[0]?.slug, 'a-few-days-in-stirling-scotland');
});

test('fetchTagNames resolves names from wp_terms', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  assert.deepEqual(await src.fetchTagNames([1], 'https://wp.example/one-final-day'), ['Scotland']);
});

test('fetchPage returns a WP page by slug', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const page = await src.fetchPage('about');
  assert.equal(page.id, 12);
  assert.equal(page.title.rendered, 'About');
  await assert.rejects(() => src.fetchPage('missing'), /no page/);
});

test('fetchSiteInfo reads blogname and blogdescription', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  assert.deepEqual(await src.fetchSiteInfo(), {
    name: 'Roll Along',
    description: 'A Travel Adventure'
  });
});

test('fetchFeaturedMediaUrl builds a URL the image fetcher can resolve', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const url = await src.fetchFeaturedMediaUrl(77);
  assert.equal(url, 'https://wp.example/wp-content/uploads/2026/05/p.jpeg#wp-image-77');
  assert.equal(await src.fetchFeaturedMediaUrl(0), null);
  assert.equal(await src.fetchFeaturedMediaUrl(4242), null);
});

test('fetchSiteBannerUrl picks the newest cropped- attachment', async (t) => {
  const fix = backup(t);
  const db = open(fix.dbPath);
  db.prepare(
    'INSERT INTO wp_posts (ID, post_date, post_title, post_status, post_name, post_type) VALUES (?,?,?,?,?,?)'
  ).run(88, '2026-06-01 00:00:00', 'banner', 'inherit', 'banner', 'attachment');
  db.prepare('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?,?,?)').run(
    88,
    '_wp_attached_file',
    '2026/06/cropped-header.jpeg'
  );
  db.close();
  const src = sqliteSource(fix);
  t.after(() => src.close());
  assert.equal(
    await src.fetchSiteBannerUrl(),
    'https://wp.example/wp-content/uploads/2026/06/cropped-header.jpeg#wp-image-88'
  );
});

test('fetchSiteBannerUrl returns null when no cropped- attachment exists', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  assert.equal(await src.fetchSiteBannerUrl(), null);
});

test('listComments returns approved only, in WpComment shape', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const r = await src.listComments();
  assert.equal(r.total, 1);
  assert.equal(r.totalPages, 1);
  assert.equal(r.comments.length, 1);
  assert.deepEqual(r.comments[0], {
    id: 1,
    post: 10,
    parent: 0,
    author_name: 'Ann',
    author_url: '',
    date: '2026-05-19T00:00:00',
    content: { rendered: 'Nice!' }
  });
});

test('fetchImage streams the original from the uploads tree', async (t) => {
  const src = sqliteSource(backup(t));
  t.after(() => src.close());
  const stream = await src.fetchImage(
    'https://wp.example/wp-content/uploads/2026/05/p-768x1024.jpeg#wp-image-77'
  );
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  assert.equal(Buffer.concat(chunks).toString(), 'IMG');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types --conditions=development test/lib/wp-sqlite.test.ts`
Expected: FAIL — `Cannot find module '.../src/lib/wp-sqlite.ts'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/wp-sqlite.ts`:

```ts
// WP content out of a database dump converted by lib/wp-dump.ts, plus
// the site's wp-content/uploads tree. Produces the same WpPost /
// WpComment shapes lib/wp-rest.ts returns, so the import pipeline runs
// unchanged with no network access.
//
// post_content is raw Gutenberg HTML rather than REST's rendered
// output. It carries real <p>/<figure>/<img> markup but no srcset, so
// each <img src> is annotated with `#wp-image-<id>` from its
// `wp-image-<id>` class; lib/wp-sqlite-images.ts uses that to reach the
// full-size original instead of the resized variant in the markup.

import type { Readable } from 'node:stream';

import { type Db, open } from './db.ts';
import { slugify } from './slugify.ts';
import type {
  CommentListResult,
  ListResult,
  WpComment,
  WpPost,
  WpSiteInfo
} from './wp-import-types.ts';
import { sqliteImageFetcher } from './wp-sqlite-images.ts';
import type { ListCommentsOpts, ListPostsOpts, WpSource } from './wp-source.ts';

export interface SqliteSourceOpts {
  /** Path to the database written by `site-admin wp-dump`. */
  dbPath: string;
  /** Path to the backup's wp-content/uploads directory. */
  uploadsRoot: string;
}

interface PostRow {
  ID: number;
  post_date: string;
  post_modified: string;
  post_content: string;
  post_title: string;
  post_excerpt: string;
  post_status: string;
  post_name: string;
}

interface CommentRow {
  comment_ID: number;
  comment_post_ID: number;
  comment_parent: number;
  comment_author: string;
  comment_author_url: string;
  comment_date: string;
  comment_content: string;
}

/** WP stores `YYYY-MM-DD HH:MM:SS`; the REST API and the importer both
 * expect ISO-8601 with a `T`. */
function isoDate(wpDate: string): string {
  return wpDate.replace(' ', 'T');
}

function slugFor(row: PostRow): string {
  if (row.post_name) return row.post_name;
  const derived = slugify(row.post_title);
  return derived.startsWith('untitled-') ? `post-${row.ID}` : derived;
}

/** Tag each <img> src with its attachment id so the image fetcher can
 * resolve the full-size original. Idempotent: an src that already
 * carries a fragment is left alone. */
function annotateImages(html: string): string {
  return html.replace(/<img\b[^>]*>/g, (tag) => {
    const id = /class="[^"]*\bwp-image-(\d+)\b[^"]*"/.exec(tag)?.[1];
    if (!id) return tag;
    return tag.replace(/src="([^"#]+)"/, `src="$1#wp-image-${id}"`);
  });
}

function statusFilter(status: string | undefined): { sql: string; params: string[] } {
  const wanted = status ?? 'publish';
  if (wanted === 'any') return { sql: "post_status IN ('publish','draft')", params: [] };
  return { sql: 'post_status = ?', params: [wanted] };
}

export function sqliteSource(opts: SqliteSourceOpts): WpSource {
  const db: Db = open(opts.dbPath);
  const fetchImage = sqliteImageFetcher(db, opts.uploadsRoot);

  const option = (name: string): string =>
    db
      .prepare<{ option_value: string }>('SELECT option_value FROM wp_options WHERE option_name = ?')
      .get(name)?.option_value ?? '';

  const siteUrl = (): string => option('siteurl').replace(/\/$/, '');

  const termIds = (postId: number, taxonomy: string): number[] =>
    db
      .prepare<{ term_id: number }>(
        `SELECT tt.term_id AS term_id
           FROM wp_term_relationships tr
           JOIN wp_term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
          WHERE tr.object_id = ? AND tt.taxonomy = ?
          ORDER BY tt.term_id`
      )
      .all(postId, taxonomy)
      .map((r) => r.term_id);

  const attachedFile = (mediaId: number): string | null =>
    db
      .prepare<{ meta_value: string }>(
        "SELECT meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key = '_wp_attached_file'"
      )
      .get(mediaId)?.meta_value ?? null;

  const toWpPost = (row: PostRow): WpPost => {
    const slug = slugFor(row);
    const thumb = db
      .prepare<{ meta_value: string }>(
        "SELECT meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key = '_thumbnail_id'"
      )
      .get(row.ID)?.meta_value;
    return {
      id: row.ID,
      date: isoDate(row.post_date),
      modified: isoDate(row.post_modified),
      slug,
      status: row.post_status,
      title: { rendered: row.post_title },
      content: { rendered: annotateImages(row.post_content) },
      excerpt: { rendered: row.post_excerpt },
      link: `${siteUrl()}/${slug}`,
      tags: termIds(row.ID, 'post_tag'),
      categories: termIds(row.ID, 'category'),
      featured_media: thumb ? Number(thumb) : 0
    };
  };

  const POST_COLUMNS =
    'ID, post_date, post_modified, post_content, post_title, post_excerpt, post_status, post_name';

  return {
    async listPosts(listOpts: ListPostsOpts = {}): Promise<ListResult> {
      const page = listOpts.page ?? 1;
      const perPage = Math.min(500, Math.max(1, listOpts.perPage ?? 50));
      const { sql, params } = statusFilter(listOpts.status);
      const where = `post_type = 'post' AND ${sql}`;
      const total =
        db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM wp_posts WHERE ${where}`).get(...params)
          ?.n ?? 0;
      const rows = db
        .prepare<PostRow>(
          `SELECT ${POST_COLUMNS} FROM wp_posts WHERE ${where} ORDER BY post_date DESC LIMIT ? OFFSET ?`
        )
        .all(...params, perPage, (page - 1) * perPage);
      return {
        posts: rows.map(toWpPost),
        total,
        totalPages: Math.max(1, Math.ceil(total / perPage))
      };
    },

    async fetchPost(idOrSlug: string | number): Promise<WpPost> {
      const byId = typeof idOrSlug === 'number' || /^\d+$/.test(String(idOrSlug));
      const row = byId
        ? db
            .prepare<PostRow>(`SELECT ${POST_COLUMNS} FROM wp_posts WHERE ID = ?`)
            .get(Number(idOrSlug))
        : db
            .prepare<PostRow>(
              `SELECT ${POST_COLUMNS} FROM wp_posts WHERE post_name = ? AND post_type = 'post'`
            )
            .get(String(idOrSlug));
      if (!row) throw new Error(`no post "${idOrSlug}" in the backup`);
      return toWpPost(row);
    },

    async fetchPage(slug: string): Promise<WpPost> {
      const row = db
        .prepare<PostRow>(
          `SELECT ${POST_COLUMNS} FROM wp_posts WHERE post_name = ? AND post_type = 'page'`
        )
        .get(slug);
      if (!row) throw new Error(`no page "${slug}" in the backup`);
      return toWpPost(row);
    },

    async fetchSiteInfo(): Promise<WpSiteInfo> {
      return { name: option('blogname'), description: option('blogdescription') };
    },

    async fetchSiteBannerUrl(): Promise<string | null> {
      // WP names custom header crops "cropped-<original>"; the newest one
      // is the header currently in use.
      const row = db
        .prepare<{ ID: number; meta_value: string }>(
          `SELECT p.ID AS ID, m.meta_value AS meta_value
             FROM wp_posts p
             JOIN wp_postmeta m ON m.post_id = p.ID AND m.meta_key = '_wp_attached_file'
            WHERE p.post_type = 'attachment' AND m.meta_value LIKE '%cropped-%'
            ORDER BY p.post_date DESC
            LIMIT 1`
        )
        .get();
      if (!row) return null;
      return `${siteUrl()}/wp-content/uploads/${row.meta_value}#wp-image-${row.ID}`;
    },

    async fetchFeaturedMediaUrl(mediaId: number): Promise<string | null> {
      if (!mediaId) return null;
      const file = attachedFile(mediaId);
      if (!file) return null;
      return `${siteUrl()}/wp-content/uploads/${file}#wp-image-${mediaId}`;
    },

    async listComments(commentOpts: ListCommentsOpts = {}): Promise<CommentListResult> {
      const page = commentOpts.page ?? 1;
      const perPage = Math.min(500, Math.max(1, commentOpts.perPage ?? 100));
      const where = "comment_approved = '1'";
      const total =
        db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM wp_comments WHERE ${where}`).get()?.n ??
        0;
      const rows = db
        .prepare<CommentRow>(
          `SELECT comment_ID, comment_post_ID, comment_parent, comment_author,
                  comment_author_url, comment_date, comment_content
             FROM wp_comments WHERE ${where}
            ORDER BY comment_date ASC LIMIT ? OFFSET ?`
        )
        .all(perPage, (page - 1) * perPage);
      const comments: WpComment[] = rows.map((r) => ({
        id: r.comment_ID,
        post: r.comment_post_ID,
        parent: r.comment_parent,
        author_name: r.comment_author,
        author_url: r.comment_author_url,
        date: isoDate(r.comment_date),
        content: { rendered: r.comment_content }
      }));
      return { comments, total, totalPages: Math.max(1, Math.ceil(total / perPage)) };
    },

    fetchImage(url: string): Promise<Readable> {
      return fetchImage(url);
    },

    async fetchTagNames(tagIds: number[]): Promise<string[]> {
      if (tagIds.length === 0) return [];
      const placeholders = tagIds.map(() => '?').join(',');
      return db
        .prepare<{ name: string }>(
          `SELECT name FROM wp_terms WHERE term_id IN (${placeholders}) ORDER BY term_id`
        )
        .all(...tagIds)
        .map((r) => r.name);
    },

    close(): void {
      db.close();
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types --conditions=development test/lib/wp-sqlite.test.ts`
Expected: PASS, 16 tests

- [ ] **Step 5: Check the file stays under the size cap**

Run: `wc -l src/lib/wp-sqlite.ts`
Expected: under 500. If it exceeds the cap, move the row→`WpPost` mapping helpers (`isoDate`, `slugFor`, `annotateImages`, `statusFilter`, `toWpPost`) into `src/lib/wp-sqlite-map.ts` and import them.

- [ ] **Step 6: Commit**

```bash
git add src/lib/wp-sqlite.ts test/lib/wp-sqlite.test.ts
git commit -m "feat(wp-sqlite): read posts, pages and comments from a WP backup"
```

---

### Task 5: CLI flags and push wiring

**Files:**
- Modify: `src/cli/import-wp.ts`, `src/cli/import-wp-comments.ts`, `src/lib/wp-push.ts`
- Test: `test/cli/import-wp-source.test.ts`

**Model:** `sonnet` — multi-file integration following existing patterns.

**Interfaces:**
- Consumes: `restSource` / `WpSource` (Task 2), `sqliteSource` (Task 4).
- Produces: `resolveSource(args: string[], baseUrl: string): WpSource` exported from `src/cli/import-wp.ts`, used by `src/cli/import-wp-comments.ts`; `PushOpts.source?: WpSource` in `src/lib/wp-push.ts`.

- [ ] **Step 1: Add the source selector to `src/cli/import-wp.ts`**

Replace the `wp-rest.ts` import at line 12 with:

```ts
import { sqliteSource } from '../lib/wp-sqlite.ts';
import { restSource, type WpSource } from '../lib/wp-source.ts';
```

Add, next to the other arg helpers at the bottom of the file:

```ts
/** Pick the content source: a converted backup when `--from-dump` is
 * present, otherwise the live REST API at `baseUrl`. Callers must
 * `close()` the result. */
export function resolveSource(args: string[], baseUrl: string): WpSource {
  const dbPath = stringFlag(args, '--from-dump');
  if (!dbPath) return restSource(baseUrl);
  const uploadsRoot = stringFlag(args, '--uploads');
  if (!uploadsRoot) throw new Error('--uploads <dir> is required with --from-dump');
  return sqliteSource({ dbPath, uploadsRoot });
}
```

Rewrite the five subcommand bodies to go through the source. In each, `baseUrl` keeps its position as the first positional argument — with `--from-dump` it is only used to label output, so pass `.` when there is no live site. Concretely:

- `list()`: replace `const r = await listPosts(baseUrl, { page, perPage, status });` with
  ```ts
  const source = resolveSource(args, baseUrl);
  try {
    const r = await source.listPosts({ page, perPage, status });
    /* …existing print loop, unchanged… */
  } finally {
    source.close();
  }
  ```
- `post()`: replace `const post = await fetchPost(baseUrl, idOrSlug);` with `const source = resolveSource(args, baseUrl);` + `const post = await source.fetchPost(idOrSlug);`, wrap the body in `try { … } finally { source.close(); }`, and pass the source's fetchers into `importPost`:
  ```ts
  const result = await importPost(post, {
    siteRoot: p.root,
    fetchImage: (url) => source.fetchImage(url),
    fetchTagNames: (ids, link) => source.fetchTagNames(ids, link)
  });
  ```
  Print the resolved slug before importing so an empty `post_name` is visible:
  ```ts
  console.log(`fetching post ${post.id} (${post.slug}): ${decodeEntities(post.title.rendered)}`);
  ```
- `push()`: build the source and hand it to `pushPost`:
  ```ts
  const source = resolveSource(args, wpBaseUrl);
  try {
    const result = await pushPost({ wpBaseUrl, slug, toUrl, token, status, source });
    /* …existing print, unchanged… */
  } finally {
    source.close();
  }
  ```
- `about()`: same shape, passing `source` to `pushPage`.
- `siteBanner()`: replace `fetchWpSiteInfo(wpBaseUrl)` with `source.fetchSiteInfo()` and `fetchWpSiteBannerUrl(wpBaseUrl)` with `source.fetchSiteBannerUrl()`. Replace the `await fetch(bannerUrl)` download with a stream read from the source so the backup path works:
  ```ts
  const stream = await source.fetchImage(bannerUrl);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  const bytes = Buffer.concat(chunks);
  ```
  then `fd.append('file', new Blob([new Uint8Array(bytes)]), filename);` where
  `const filename = bannerUrl.replace(/#.*$/, '').split('/').pop() ?? 'banner.jpg';`

Extend the usage string at the top:

```ts
    throw new Error(
      `usage:
  site-admin import-wp about <wp-base-url> --to <target-url> [--token TOKEN]
  site-admin import-wp list <base-url> [--page N] [--per-page N] [--status publish|draft|any]
  site-admin import-wp post <base-url> <id-or-slug> [--force]
  site-admin import-wp push <wp-base-url> <slug> --to <fly-url> [--token TOKEN] [--status STATUS]

  any subcommand may read a backup instead of a live site:
    --from-dump <db>   database written by \`site-admin wp-dump\`
    --uploads <dir>    the backup's wp-content/uploads directory`
    );
```

- [ ] **Step 2: Accept an injected source in `src/lib/wp-push.ts`**

Add to `PushOpts`:

```ts
  /** Content source. Default: the REST API at `wpBaseUrl`. Pass a
   * sqliteSource to push from a backup. */
  source?: WpSource;
```

with `import type { WpSource } from './wp-source.ts';`.

Change `pushPost` and `pushPage` to use it:

```ts
export async function pushPost(opts: PushOpts): Promise<PushResult> {
  const post = opts.source
    ? await opts.source.fetchPost(opts.slug)
    : await fetchWpPost(opts.fetcher ?? fetch, opts.wpBaseUrl, opts.slug);
  return pushWpObject(post, opts);
}

export async function pushPage(opts: PushOpts): Promise<PushResult> {
  const page = opts.source
    ? await opts.source.fetchPage(String(opts.slug))
    : await fetchWpPage(opts.wpBaseUrl, String(opts.slug), opts.fetcher);
  page.slug = '_about';
  return pushWpObject(page, opts);
}
```

In `pushWpObject`, prefer the source for the banner URL and the image fetcher:

```ts
  const bannerUrl = post.featured_media
    ? ((opts.source
        ? await opts.source.fetchFeaturedMediaUrl(post.featured_media)
        : await fetchFeaturedMediaUrlDirect(fetcher, opts.wpBaseUrl, post.featured_media)) ??
      undefined)
    : undefined;
```

and in the `importPost` call:

```ts
    const imageFetcher = opts.fetchImage ?? (opts.source ? opts.source.fetchImage : undefined);
    const result = await importPost(post, {
      siteRoot: tmp,
      ...(imageFetcher ? { fetchImage: imageFetcher } : {}),
      ...(opts.source ? { fetchTagNames: opts.source.fetchTagNames } : {}),
      ...(bannerUrl ? { bannerUrl } : {})
    });
```

- [ ] **Step 3: Add the flags to `src/cli/import-wp-comments.ts`**

Change `importWpComments` to take a source instead of a base URL + fetcher:

```ts
export async function importWpComments(
  source: WpSource,
  siteRoot: string
): Promise<ImportCommentsResult> {
```

Inside, replace `buildWpIdToSlug(baseUrl, fetcher)` with a version that takes the source:

```ts
async function buildWpIdToSlug(source: WpSource): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  let page = 1;
  for (;;) {
    const r = await source.listPosts({ page, perPage: 100, status: 'publish' });
    for (const p of r.posts) map.set(p.id, p.slug);
    if (page >= r.totalPages || r.posts.length === 0) break;
    page++;
  }
  return map;
}
```

and `listComments(baseUrl, {...}, fetcher)` with `source.listComments({ page, perPage: 100 })`.

Update the command entry point:

```ts
export default async function importWpCommentsCmd(argv: string[]): Promise<void> {
  const baseUrl = argv[0];
  if (!baseUrl) {
    throw new Error(
      'usage: site-admin import-wp-comments <wp-base-url> [--from-dump <db> --uploads <dir>]'
    );
  }
  /* c8 ignore start -- success path touches the real site DB; covered by importWpComments tests */
  const { paths } = await import('../lib/config.ts');
  const { resolveSource } = await import('./import-wp.ts');
  const source = resolveSource(argv.slice(1), baseUrl);
  try {
    const r = await importWpComments(source, paths().root);
    console.log(`imported ${r.inserted} comment(s), skipped ${r.skipped}`);
  } finally {
    source.close();
  }
  /* c8 ignore stop */
}
```

Update `test/cli/import-wp-comments.test.ts` to build a source from its existing stub fetcher: replace each `importWpComments(baseUrl, root, fetcher)` call with `importWpComments(restSource(baseUrl, fetcher), root)`, importing `restSource` from `../../src/lib/wp-source.ts`.

- [ ] **Step 4: Write the integration test**

Create `test/cli/import-wp-source.test.ts`:

```ts
// resolveSource: the --from-dump / --uploads flag pair selects the
// backup source; without them the REST source is used.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { resolveSource } from '../../src/cli/import-wp.ts';

function emptyBackup(t: TestContext): { dbPath: string; uploadsRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-wp-src-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'wp.db');
  const db = open(dbPath);
  db.exec(`
    CREATE TABLE wp_posts (ID INTEGER PRIMARY KEY, post_date TEXT, post_modified TEXT,
      post_content TEXT, post_title TEXT, post_excerpt TEXT, post_status TEXT,
      post_name TEXT, post_type TEXT);
    CREATE TABLE wp_postmeta (post_id INTEGER, meta_key TEXT, meta_value TEXT);
    CREATE TABLE wp_terms (term_id INTEGER PRIMARY KEY, name TEXT, slug TEXT);
    CREATE TABLE wp_term_taxonomy (term_taxonomy_id INTEGER PRIMARY KEY, term_id INTEGER, taxonomy TEXT);
    CREATE TABLE wp_term_relationships (object_id INTEGER, term_taxonomy_id INTEGER);
    CREATE TABLE wp_options (option_name TEXT, option_value TEXT);
    CREATE TABLE wp_comments (comment_ID INTEGER PRIMARY KEY, comment_post_ID INTEGER,
      comment_author TEXT, comment_author_url TEXT, comment_date TEXT,
      comment_content TEXT, comment_approved TEXT, comment_parent INTEGER);
  `);
  db.close();
  const uploadsRoot = path.join(root, 'uploads');
  fs.mkdirSync(uploadsRoot);
  return { dbPath, uploadsRoot };
}

test('resolveSource: --from-dump selects the backup source', async (t) => {
  const fix = emptyBackup(t);
  const source = resolveSource(
    ['--from-dump', fix.dbPath, '--uploads', fix.uploadsRoot],
    'https://wp.example'
  );
  t.after(() => source.close());
  const r = await source.listPosts();
  assert.equal(r.total, 0);
});

test('resolveSource: --from-dump without --uploads is an error', (t) => {
  const fix = emptyBackup(t);
  assert.throws(
    () => resolveSource(['--from-dump', fix.dbPath], 'https://wp.example'),
    /--uploads <dir> is required/
  );
});

test('resolveSource: no flags yields the REST source', () => {
  const source = resolveSource([], 'https://wp.example');
  assert.equal(typeof source.listPosts, 'function');
  source.close();
});
```

- [ ] **Step 5: Run the full unit suite**

Run: `npm test`
Expected: PASS, including the updated `test/cli/import-wp-comments.test.ts` and `test/lib/wp-push.test.ts`.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npx biome check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/cli/import-wp.ts src/cli/import-wp-comments.ts src/lib/wp-push.ts \
        test/cli/import-wp-source.test.ts test/cli/import-wp-comments.test.ts
git commit -m "feat(import-wp): --from-dump reads posts and comments from a backup"
```

---

### Task 6: End-to-end against the real backup, plus docs

**Files:**
- Create: `test/lib/wp-sqlite-backup.test.ts`
- Modify: `docs/RUNBOOK.md`, `docs/spec.md`, `docs/developer-quickstart.md`

**Model:** `sonnet` — verification against real data and documentation.

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: no new exports.

- [ ] **Step 1: Write the backup test**

Create `test/lib/wp-sqlite-backup.test.ts`. It converts the real dump and imports the missing post, and skips itself when the backup isn't present so the suite still passes on a fresh clone:

```ts
// End-to-end over the real roll-along backup. Skipped when the backup
// tree isn't checked out beside this repo.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { parsePost } from '../../src/lib/content.ts';
import { convertDump } from '../../src/lib/wp-dump.ts';
import { importPost } from '../../src/lib/wp-import.ts';
import { sqliteSource } from '../../src/lib/wp-sqlite.ts';

const BACKUP = path.resolve(import.meta.dirname, '../../../roll-along');
const DUMP = path.join(BACKUP, 'db/rollalong.sql');
const UPLOADS = path.join(BACKUP, 'site/wp-content/uploads');
const have = fs.existsSync(DUMP) && fs.existsSync(UPLOADS);

function siteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-wp-backup-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'data', 'content/posts']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('imports one-final-day from the real backup', { skip: !have }, async (t) => {
  const root = siteRoot(t);
  const dbPath = path.join(root, 'wp.db');
  const stats = convertDump(DUMP, dbPath);
  assert.ok(stats.rows > 8000, `expected a full dump, got ${stats.rows} rows`);

  const source = sqliteSource({ dbPath, uploadsRoot: UPLOADS });
  t.after(() => source.close());

  const published = await source.listPosts({ perPage: 500 });
  assert.equal(published.total, 65);

  const post = await source.fetchPost('one-final-day');
  assert.equal(post.title.rendered, 'One final day');

  const result = await importPost(post, {
    siteRoot: root,
    fetchImage: (url) => source.fetchImage(url),
    fetchTagNames: (ids, link) => source.fetchTagNames(ids, link)
  });
  assert.deepEqual(result.imageErrors, []);
  assert.ok(result.imagesIngested.length > 0, 'expected at least one ingested image');
  assert.equal(result.filename, '2026-05-18-one-final-day.md');

  const parsed = parsePost(result.markdown);
  assert.equal(parsed.frontmatter.slug, 'one-final-day');
  assert.equal(parsed.frontmatter.title, 'One final day');
  assert.match(parsed.body, /::figure\{ids="/);
});

test('the three WP drafts get usable slugs', { skip: !have }, async (t) => {
  const root = siteRoot(t);
  const dbPath = path.join(root, 'wp.db');
  convertDump(DUMP, dbPath);
  const source = sqliteSource({ dbPath, uploadsRoot: UPLOADS });
  t.after(() => source.close());

  const drafts = await source.listPosts({ status: 'draft', perPage: 100 });
  assert.equal(drafts.total, 3);
  for (const d of drafts.posts) {
    assert.match(d.slug, /^[a-z0-9][a-z0-9-]*$/, `bad slug for "${d.title.rendered}"`);
  }
});
```

Verify `parsePost`'s exported shape before relying on it — read `src/lib/content.ts` and adjust the two `parsed.` assertions to match its actual return type.

- [ ] **Step 2: Run it**

Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types --conditions=development test/lib/wp-sqlite-backup.test.ts`
Expected: PASS, 2 tests. If images fail to resolve, print `result.imageErrors` and fix `resolveAttachmentPath` — do not weaken the assertion.

- [ ] **Step 3: Update `docs/RUNBOOK.md`**

After the existing `import-wp` section (around line 187), add:

```markdown
### Importing from a database backup

When the WordPress install is gone, the importer can read a
`mariadb-dump` file plus the site's uploads tree instead. Convert the
dump once:

```bash
bin/site-admin wp-dump ../roll-along/db/rollalong.sql /tmp/rollalong.db
```

Then pass `--from-dump` and `--uploads` to any `import-wp` subcommand.
The base-URL argument is still required — it labels output and supplies
the `link` field — but nothing is fetched over the network:

```bash
UPLOADS=../roll-along/site/wp-content/uploads

bin/site-admin import-wp list https://roll-along.rkroll.com \
  --from-dump /tmp/rollalong.db --uploads "$UPLOADS" --status any

bin/site-admin import-wp push https://roll-along.rkroll.com one-final-day \
  --to https://rkr-blog.rkroll.com --from-dump /tmp/rollalong.db --uploads "$UPLOADS"
```

WordPress leaves `post_name` empty until a post is first published, so
drafts get a slug derived from their title. `import-wp list --status
draft` prints the derived slug; check it before pushing.

`--status draft` on `push` lands the post unpublished. A WP draft is
never published without an explicit `--status published`.
```

- [ ] **Step 4: Update `docs/spec.md`**

In the operator-command list (around line 528), add:

```
wp-dump <dump.sql> <out.db>                 convert a mysqldump file to SQLite
import-wp … --from-dump <db> --uploads <d>  read a backup instead of a live WordPress site
```

- [ ] **Step 5: Run the whole gauntlet**

Run: `npm run typecheck && npx biome check && npm run knip:gate && npm run test:coverage`
Expected: all pass, including the per-file coverage floors on the four new `src/lib` files.

- [ ] **Step 6: Commit**

```bash
git add test/lib/wp-sqlite-backup.test.ts docs/RUNBOOK.md docs/spec.md
git commit -m "test(wp-sqlite): end-to-end import from the roll-along backup"
```

---

### Task 7: Import the missing content

**Files:** none — this is an operational step run against the live site.

**Model:** `opus` — writes to production; needs judgement about what to publish.

**Interfaces:**
- Consumes: the CLI from Tasks 1–6.

- [ ] **Step 1: Convert the dump**

```bash
bin/site-admin wp-dump ../roll-along/db/rollalong.sql /tmp/rollalong.db
```

- [ ] **Step 2: Dry-run the import locally**

```bash
UPLOADS=../roll-along/site/wp-content/uploads
SITE_ROOT=$HOME/site bin/site-admin import-wp post https://roll-along.rkroll.com one-final-day \
  --from-dump /tmp/rollalong.db --uploads "$UPLOADS"
```
Expected: `wrote …/content/posts/2026-05-18-one-final-day.md`, ingested images, no failures. Read the markdown before going further.

- [ ] **Step 3: Report to the user and stop**

Print the local markdown path, the image count, and the three draft slugs from
`import-wp list … --status draft`. **Do not push to the live site.** Pushing publishes content and is the user's call — ask which of the four posts they want pushed and at what status.

---

## Self-Review

**Spec coverage:** `wp-dump` module + CLI (Task 1); `WpSource` and the REST adapter (Task 2); image resolution with the containment check (Task 3); every row of the source-mapping table, slug fallback, status filter, approved-only comments (Task 4); CLI flags, push injection, comment importer (Task 5); tests, real-backup verification, docs (Task 6). The spec's "out of scope" note (no re-import of the 64 posts already live) is honoured by Task 7 importing only the missing post.

**Placeholders:** none — every code step carries complete code. Two steps carry a conditional instruction (the 500-line split in Task 4 Step 5, the `parsePost` shape check in Task 6 Step 1); both name the exact fix.

**Type consistency:** `WpSource` members are used identically in Tasks 2, 4 and 5. `sqliteSource` takes `SqliteSourceOpts { dbPath, uploadsRoot }` everywhere. `sqliteImageFetcher(db, uploadsRoot)` matches `importPost`'s `fetchImage: (url: string) => Promise<Readable>`. `convertDump(sqlPath, dbPath): DumpStats` is called with the same signature in Tasks 1, 6 and 7. The `#wp-image-<id>` URL fragment is produced in Task 4 (`annotateImages`, `fetchFeaturedMediaUrl`, `fetchSiteBannerUrl`) and consumed in Task 3 (`resolveAttachmentPath`).
