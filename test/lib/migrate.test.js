import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { open } from '../../src/lib/db.js';
import { migrate, listMigrations } from '../../src/lib/migrate.js';

test('migrate() applies the initial migration once', () => {
  const db = open(':memory:');
  try {
    const first = migrate(db);
    assert.deepEqual(first, [1], 'first run applies version 1');

    // Tables from 001_initial.sql must exist.
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map((r) => r.name);
    for (const t of ['posts', 'jobs', 'sessions', 'oauth_tokens', 'auth', 'schema_migrations']) {
      assert.ok(tables.includes(t), `expected table ${t} in ${tables.join(',')}`);
    }

    const second = migrate(db);
    assert.deepEqual(second, [], 'second run is a no-op');
  } finally {
    db.close();
  }
});

test('migrate() runs against a real sqlite file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'site.db');

  const db = open(dbPath);
  try {
    migrate(db);
    const r = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    assert.deepEqual(r, [{ version: 1 }]);
  } finally {
    db.close();
  }
});

test('listMigrations() ignores non-SQL files and sorts numerically', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-mig-list-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, '010_b.sql'), '-- b');
  fs.writeFileSync(path.join(dir, '002_a.sql'), '-- a');
  fs.writeFileSync(path.join(dir, 'README.md'), 'ignore me');
  fs.writeFileSync(path.join(dir, 'no_version.sql'), '-- nope');

  const list = listMigrations(dir).map((m) => m.version);
  assert.deepEqual(list, [2, 10]);
});
