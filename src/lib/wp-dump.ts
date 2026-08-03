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

/** Index of the last character of the comment starting at `i`, or null if
 * none starts there. `--` needs trailing whitespace (or end of input) so
 * that `1--2` stays arithmetic. MySQL's `/*!… *\/` executable comments are
 * ordinary comments here: the statements inside are ones we ignore anyway. */
function commentEnd(text: string, i: number): number | null {
  const c = text[i];
  const two = text[i + 1];
  const isLine =
    c === '#' ||
    (c === '-' && two === '-' && (i + 2 >= text.length || /\s/.test(text[i + 2] ?? '')));
  if (isLine) {
    const nl = text.indexOf('\n', i);
    return nl === -1 ? text.length - 1 : nl - 1;
  }
  if (c === '/' && two === '*') {
    const end = text.indexOf('*/', i + 2);
    // An unterminated block comment means a truncated file. Swallowing the
    // rest silently would report success over a near-empty database.
    if (end === -1) throw new Error('unterminated /* comment — dump file is truncated');
    return end + 1;
  }
  return null;
}

/** Split SQL into top-level statements, respecting ' " ` quoting and
 * backslash escapes so a `;` inside a string literal doesn't split.
 * Comments are dropped, and their text never affects quote state. */
function* statements(text: string): Generator<string> {
  let buf = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      buf += c;
      if (c === '\\' && quote !== '`') {
        i++;
        if (i < text.length) buf += text[i];
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    const end = commentEnd(text, i);
    if (end !== null) {
      i = end;
      buf += ' ';
      continue;
    }
    buf += c;
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

const SKIP_CLAUSE =
  /^(primary\s+key|unique\s+key|fulltext\s+key|spatial\s+key|key|index|constraint|foreign\s+key)\b/i;

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
      } else if (' \t\r\n'.includes(c)) {
        i++;
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

/** Render a dump's `(a,b,c)` column list as ``(`a`,`b`,`c`)``. Empty for a
 * positional INSERT, where the row order is the table's own. */
function columnList(raw: string | undefined): string {
  if (!raw) return '';
  const cols = raw
    .slice(1, -1)
    .split(',')
    .map((c) => c.trim().replace(/^`|`$/g, ''))
    .filter((c) => c !== '');
  if (cols.length === 0) return '';
  return ` (${cols.map((c) => `\`${c}\``).join(',')})`;
}

// Any statement that carries rows. Matched broadly on purpose: a dump taken
// with --insert-ignore or --replace must reach the unparseable-INSERT throw
// below rather than being skipped into a silently empty database.
const ROW_STATEMENT = /^(INSERT|REPLACE)\b/i;
const ROW_INSERT =
  /^(?:INSERT(?:\s+(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE))*|REPLACE(?:\s+(?:LOW_PRIORITY|DELAYED))*)\s+INTO\s+`([^`]+)`\s*(\([^)]*\))?\s*VALUES\s*([\s\S]*?);?\s*$/i;

function unparseableInsert(stmt: string): string {
  const table = /\bINTO\s+`?([^`\s(]+)/i.exec(stmt)?.[1] ?? '?';
  const excerpt = stmt.length > 160 ? `${stmt.slice(0, 160)}…` : stmt;
  return `unparseable INSERT INTO \`${table}\`: ${excerpt}`;
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
      if (!s) continue;
      if (/^CREATE TABLE/i.test(s)) {
        const created = convertCreate(s);
        if (!created) continue;
        db.exec(`DROP TABLE IF EXISTS \`${created.table}\``);
        db.exec(created.ddl);
        tables++;
      } else if (ROW_STATEMENT.test(s)) {
        const m = ROW_INSERT.exec(s);
        const parsed = m ? parseValues(m[3] as string) : [];
        if (!m || parsed.length === 0) throw new Error(unparseableInsert(s));
        const placeholders = (parsed[0] as Cell[]).map(() => '?').join(',');
        const insert = db.prepare(
          `INSERT INTO \`${m[1]}\`${columnList(m[2])} VALUES (${placeholders})`
        );
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
