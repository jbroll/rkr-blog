// Thin wrapper over node:sqlite. Earns its keep by:
// - normalizing rows to plain objects (node:sqlite returns null-prototype),
// - providing a transaction() helper (node:sqlite has none),
// - coercing bigint lastInsertRowid to Number,
// - giving migrations a single place to handle PRAGMAs.
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
//   stmt.iterate(...params) -> AsyncIterator<row>

import { DatabaseSync } from 'node:sqlite';

// node:sqlite returns rows with a null prototype. Normalize to plain objects
// so the surface matches better-sqlite3 and assert.deepEqual works as expected.
function plain(row) {
  return row == null ? row : { ...row };
}

function wrapStatement(rawStmt) {
  return {
    run(...params) {
      const r = rawStmt.run(...params);
      return {
        changes: Number(r.changes ?? 0),
        lastInsertRowid:
          typeof r.lastInsertRowid === 'bigint'
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
      for (const row of rawStmt.all(...params)) yield plain(row);
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
      return wrapStatement(raw.prepare(sql));
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
