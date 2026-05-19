// Thin wrapper over node:sqlite. Earns its keep by:
// - normalizing rows to plain objects (node:sqlite returns null-prototype),
// - providing a transaction() helper (node:sqlite has none),
// - coercing bigint lastInsertRowid to Number,
// - giving migrations a single place to handle PRAGMAs.
//
// Surface per implementation.md §4. Generic Statement<TRow, TParams> is
// opt-in: callers that don't pass type args get `unknown` rows and
// `SqlParam[]` params.

import { DatabaseSync } from 'node:sqlite';

export type SqlParam = string | number | bigint | boolean | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface Statement<TRow = unknown> {
  run(...params: SqlParam[]): RunResult;
  get(...params: SqlParam[]): TRow | undefined;
  all(...params: SqlParam[]): TRow[];
  iterate(...params: SqlParam[]): AsyncIterableIterator<TRow>;
}

export interface Db {
  prepare<TRow = unknown>(sql: string): Statement<TRow>;
  exec(sql: string): void;
  transaction<TArgs extends unknown[], TRet>(
    fn: (...args: TArgs) => TRet
  ): (...args: TArgs) => TRet;
  pragma(name: string, value?: string | number): unknown;
  close(): void;
}

// node:sqlite returns rows with a null prototype. Normalize so that
// assert.deepEqual and JSON.stringify behave as expected.
function plain<T>(row: T): T {
  if (row === null || row === undefined) return row;
  return { ...(row as object) } as T;
}

interface RawStatement {
  run(...params: SqlParam[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
  get(...params: SqlParam[]): unknown;
  all(...params: SqlParam[]): unknown[];
}

function wrapStatement<TRow>(rawStmt: RawStatement): Statement<TRow> {
  return {
    run(...params) {
      const r = rawStmt.run(...params);
      const lastId = r.lastInsertRowid;
      return {
        changes: Number(r.changes ?? 0),
        lastInsertRowid: typeof lastId === 'bigint' ? Number(lastId) : (lastId ?? 0)
      };
    },
    get(...params) {
      const row = rawStmt.get(...params);
      return row === undefined ? undefined : (plain(row) as TRow);
    },
    all(...params) {
      return rawStmt.all(...params).map((row) => plain(row) as TRow);
    },
    async *iterate(...params) {
      for (const row of rawStmt.all(...params)) yield plain(row) as TRow;
    }
  };
}

/**
 * Open a database. Sets WAL mode and foreign keys on first open.
 * `:memory:` is a valid path.
 */
export function open(filepath: string): Db {
  const raw = new DatabaseSync(filepath);

  // PRAGMAs. WAL is a no-op for :memory: but harmless.
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('PRAGMA busy_timeout = 5000;');

  const db: Db = {
    prepare<TRow>(sql: string) {
      return wrapStatement<TRow>(raw.prepare(sql) as RawStatement);
    },

    exec(sql) {
      raw.exec(sql);
    },

    transaction<TArgs extends unknown[], TRet>(fn: (...args: TArgs) => TRet) {
      return (...args: TArgs): TRet => {
        raw.exec('BEGIN');
        try {
          const result = fn(...args);
          raw.exec('COMMIT');
          return result;
        } catch (err) {
          try {
            raw.exec('ROLLBACK');
          } catch {
            /* swallow rollback failure */
          }
          throw err;
        }
      };
    },

    pragma(name, value) {
      if (value === undefined) {
        const row = raw.prepare(`PRAGMA ${name}`).get();
        if (!row) return undefined;
        const obj = plain(row) as Record<string, unknown>;
        const keys = Object.keys(obj);
        const first = keys[0];
        if (keys.length === 1 && first !== undefined) return obj[first];
        return obj;
      }
      raw.exec(`PRAGMA ${name} = ${value}`);
      return undefined;
    },

    close() {
      raw.close();
    }
  };

  return db;
}
