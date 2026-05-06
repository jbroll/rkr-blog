// Migration runner. Reads files from the migrations/ directory, sorts them
// numerically by leading integer, applies any version not already in
// schema_migrations inside its own transaction.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Repo layout: src/lib/migrate.js → ../../migrations
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

function parseVersion(filename) {
  const m = filename.match(/^(\d+)/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

export function listMigrations(dir = DEFAULT_MIGRATIONS_DIR) {
  const entries = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((filename) => ({
      filename,
      version: parseVersion(filename),
      full: path.join(dir, filename)
    }))
    .filter((m) => m.version !== null)
    .sort((a, b) => a.version - b.version);
  return entries;
}

function readApplied(db) {
  // Probe sqlite_master rather than CREATE-IF-NOT-EXISTS so that the
  // schema_migrations table can be created by the migration itself.
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
  ).get();
  if (!exists) return new Set();
  return new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );
}

/**
 * Apply pending migrations. Returns the list of versions actually applied.
 *
 * @param {Object} db   - db handle from lib/db.js
 * @param {string} [dir] - migrations directory (default: repo migrations/)
 */
export function migrate(db, dir = DEFAULT_MIGRATIONS_DIR) {
  const applied = readApplied(db);

  const todo = listMigrations(dir).filter((m) => !applied.has(m.version));
  const ranVersions = [];

  for (const m of todo) {
    const sql = fs.readFileSync(m.full, 'utf8');
    // Each migration runs in its own transaction. We can't BEGIN around
    // statements that include PRAGMAs that must run outside a transaction
    // (e.g. journal_mode), so we split: PRAGMA lines first, the rest in tx.
    const { pragmas, body } = splitPragmas(sql);
    if (pragmas.trim()) db.exec(pragmas);

    const runBody = db.transaction(() => {
      if (body.trim()) db.exec(body);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(m.version, new Date().toISOString());
    });
    runBody();

    ranVersions.push(m.version);
  }

  return ranVersions;
}

// PRAGMA journal_mode and similar statements fail inside an explicit
// transaction. Strip leading PRAGMAs out of the migration body so they run
// outside the transactional block.
function splitPragmas(sql) {
  const lines = sql.split('\n');
  const pragmas = [];
  const body = [];
  let inHeader = true;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inHeader && (trimmed === '' || trimmed.startsWith('--') || /^PRAGMA\s/i.test(trimmed))) {
      pragmas.push(line);
    } else {
      inHeader = false;
      body.push(line);
    }
  }
  return { pragmas: pragmas.join('\n'), body: body.join('\n') };
}
