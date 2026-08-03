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
