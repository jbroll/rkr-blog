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
  const { db, stats } = convert(
    t,
    `${POSTS_DDL}
INSERT INTO \`wp_posts\` VALUES (1,'Hello','<p>Hi</p>',0,1.5);
`
  );
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
  const { db, stats } = convert(
    t,
    `${POSTS_DDL}
INSERT INTO \`wp_posts\` VALUES (1,'It\\'s a (test); ok','line1\\nline2',0,NULL),(2,'quote '' here','back\\\\slash',3,2.5);
`
  );
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
  const { db, stats } = convert(
    t,
    `
/*!40101 SET NAMES utf8mb4 */;
-- a comment with a ; semicolon
LOCK TABLES \`wp_posts\` WRITE;
${POSTS_DDL}
INSERT INTO \`wp_posts\` (\`ID\`,\`post_title\`,\`post_content\`,\`menu_order\`,\`ratio\`) VALUES (7,'T','C',0,NULL);
UNLOCK TABLES;
`
  );
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
