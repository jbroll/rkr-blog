// Thin wrapper over node:sqlite. The shape matches better-sqlite3 closely
// enough that swapping the underlying driver later is a one-file change.
//
// Surface (per spec §15):
//   db.prepare(sql)         -> Statement
//   db.exec(sql)            -> void
//   db.transaction(fn)      -> wrapped fn (BEGIN/COMMIT/ROLLBACK)
//   db.pragma(name, value?) -> result
//   db.close()              -> void
//
//   stmt.run(...params)     -> { changes, lastInsertRowid }
//   stmt.get(...params)     -> row | undefined
//   stmt.all(...params)     -> row[]
//   stmt.iterate(...params) -> AsyncIterator<row>   (paged SELECT)

import { DatabaseSync } from 'node:sqlite';

const ITERATE_PAGE_SIZE = 1000;

// node:sqlite returns rows with a null prototype. Normalize to plain objects
// so the surface matches better-sqlite3 and assert.deepEqual works as expected.
function plain(row) {
  return row == null ? row : { ...row };
}

function wrapStatement(rawStmt, sql, dbHandle) {
  return {
    run(...params) {
      const r = rawStmt.run(...params);
      return {
        changes: Number(r.changes ?? 0),
        lastInsertRowid: typeof r.lastInsertRowid === 'bigint'
          ? Number(r.lastInsertRowid)
          : (r.lastInsertRowid ?? 0)
      };
    },
    get(...params) {
      const row = rawStmt.get(...params);
      return row === undefined ? undefined : plain(row);
    },
    all(...params) {
      return rawStmt.all(...params).map(plain);
    },
    async *iterate(...params) {
      // Paged SELECT so the surface stays stable across drivers.
      // Wrap the original SQL in a subquery with LIMIT/OFFSET parameters.
      const pagedSql = `SELECT * FROM (${sql}) LIMIT ? OFFSET ?`;
      const pagedStmt = dbHandle.prepare(pagedSql);
      let offset = 0;
      while (true) {
        const rows = pagedStmt.all(...params, ITERATE_PAGE_SIZE, offset);
        if (rows.length === 0) return;
        for (const row of rows) yield plain(row);
        if (rows.length < ITERATE_PAGE_SIZE) return;
        offset += ITERATE_PAGE_SIZE;
      }
    }
  };
}

/**
 * Open a database. Sets WAL mode and foreign keys on first open.
 * `:memory:` is a valid path.
 *
 * @param {string} path
 * @returns {Object} db handle
 */
export function open(path) {
  const raw = new DatabaseSync(path);

  // PRAGMAs. WAL is a no-op for :memory: but harmless.
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');

  const db = {
    prepare(sql) {
      const rawStmt = raw.prepare(sql);
      return wrapStatement(rawStmt, sql, raw);
    },

    exec(sql) {
      raw.exec(sql);
    },

    transaction(fn) {
      return (...args) => {
        raw.exec('BEGIN');
        try {
          const result = fn(...args);
          raw.exec('COMMIT');
          return result;
        } catch (err) {
          try { raw.exec('ROLLBACK'); } catch { /* swallow rollback failure */ }
          throw err;
        }
      };
    },

    pragma(name, value) {
      if (value === undefined) {
        const row = raw.prepare(`PRAGMA ${name}`).get();
        if (!row) return undefined;
        const obj = plain(row);
        const keys = Object.keys(obj);
        return keys.length === 1 ? obj[keys[0]] : obj;
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
