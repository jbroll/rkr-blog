import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { listMigrations, migrate } from '../../src/lib/migrate.ts';

test('migrate() applies all migrations once; second run is a no-op', () => {
  const db = open(':memory:');
  try {
    const first = migrate(db);
    // 001 (initial) + 002 (auth refactor); update assertion as new
    // migrations land.
    assert.deepEqual(first, [1, 2], 'first run applies all known versions');

    // Final-state tables (post-002): users + sessions + oauth_accounts +
    // allowed_emails + oauth_tokens + posts + jobs + schema_migrations.
    const tables = db
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    for (const t of [
      'posts',
      'jobs',
      'users',
      'oauth_accounts',
      'allowed_emails',
      'sessions',
      'oauth_tokens',
      'schema_migrations'
    ]) {
      assert.ok(tables.includes(t), `expected table ${t} in ${tables.join(',')}`);
    }
    // 002 dropped the auth table.
    assert.equal(tables.includes('auth'), false, 'auth table is dropped by 002');

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
    assert.deepEqual(r, [{ version: 1 }, { version: 2 }]);
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
