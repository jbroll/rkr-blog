import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { open } from '../../src/lib/db.ts';

test('open(:memory:) returns a working db handle', () => {
  const db = open(':memory:');
  try {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
    const r = ins.run('hello');
    assert.equal(r.changes, 1);
    assert.equal(r.lastInsertRowid, 1);

    const row = db.prepare('SELECT v FROM t WHERE id = ?').get(1);
    assert.deepEqual(row, { v: 'hello' });

    const rows = db.prepare('SELECT v FROM t').all();
    assert.deepEqual(rows, [{ v: 'hello' }]);
  } finally {
    db.close();
  }
});

test('open(file path) creates a real db on disk', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.db');

  const db = open(file);
  db.exec('CREATE TABLE k (id INTEGER PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO k (v) VALUES (?)').run('persisted');
  db.close();

  assert.ok(fs.existsSync(file), 'db file should exist on disk');

  // Re-open and read back: round-trip across processes-equivalent boundary.
  const db2 = open(file);
  try {
    const row = db2.prepare('SELECT v FROM k LIMIT 1').get();
    assert.deepEqual(row, { v: 'persisted' });
  } finally {
    db2.close();
  }
});

test('transaction() commits on success, rolls back on throw', () => {
  const db = open(':memory:');
  try {
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

    const insertTwo = db.transaction((a: string, b: string) => {
      db.prepare('INSERT INTO t (v) VALUES (?)').run(a);
      db.prepare('INSERT INTO t (v) VALUES (?)').run(b);
    });
    insertTwo('a', 'b');
    const countStmt = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM t');
    assert.equal(countStmt.get()?.n, 2);

    const failing = db.transaction(() => {
      db.prepare('INSERT INTO t (v) VALUES (?)').run('c');
      throw new Error('boom');
    });
    assert.throws(() => failing(), /boom/);
    assert.equal(countStmt.get()?.n, 2, 'rollback should leave the row count unchanged');
  } finally {
    db.close();
  }
});

test('iterate() yields all rows across pages', async () => {
  const db = open(':memory:');
  try {
    db.exec('CREATE TABLE n (id INTEGER PRIMARY KEY)');
    const insert = db.prepare('INSERT INTO n (id) VALUES (?)');
    for (let i = 1; i <= 2500; i++) insert.run(i);

    const stmt = db.prepare<{ id: number }>('SELECT id FROM n ORDER BY id');
    const seen: number[] = [];
    for await (const row of stmt.iterate()) seen.push(row.id);
    assert.equal(seen.length, 2500);
    assert.equal(seen[0], 1);
    assert.equal(seen[seen.length - 1], 2500);
  } finally {
    db.close();
  }
});

test('pragma(name) reads and pragma(name, value) sets', () => {
  const db = open(':memory:');
  try {
    // foreign_keys was set ON during open()
    assert.equal(db.pragma('foreign_keys'), 1);
    db.pragma('foreign_keys', 0);
    assert.equal(db.pragma('foreign_keys'), 0);
    // string value path (quoted in the SQL) — use locking_mode as it
    // accepts a string and works on :memory: databases
    db.pragma('locking_mode', 'exclusive');
    assert.equal(db.pragma('locking_mode'), 'exclusive');
  } finally {
    db.close();
  }
});

test('pragma(name) rejects invalid names', () => {
  const db = open(':memory:');
  try {
    assert.throws(() => db.pragma('bad name'), /invalid pragma name/);
    assert.throws(() => db.pragma('bad;name'), /invalid pragma name/);
  } finally {
    db.close();
  }
});
