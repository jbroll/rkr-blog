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

test('convertDump: keeps a statement that follows a comment line', (t) => {
  const { db, stats } = convert(
    t,
    `${POSTS_DDL}
-- Dumping data for table \`wp_posts\`
INSERT INTO \`wp_posts\` VALUES (1,'A','B',0,NULL);
# hash comment
INSERT INTO \`wp_posts\` VALUES (2,'C','D',0,NULL);
/* block
   comment */
INSERT INTO \`wp_posts\` VALUES (3,'E','F',0,NULL);
/*!40000 ALTER TABLE \`wp_posts\` ENABLE KEYS */;
`
  );
  assert.equal(stats.tables, 1);
  assert.equal(stats.rows, 3);
  const ids = db.prepare<{ ID: number }>('SELECT ID FROM wp_posts ORDER BY ID').all();
  assert.deepEqual(
    ids.map((r) => r.ID),
    [1, 2, 3]
  );
});

test('convertDump: an apostrophe in a comment does not open a string', (t) => {
  const { db, stats } = convert(
    t,
    `${POSTS_DDL}
-- it's fine
INSERT INTO \`wp_posts\` VALUES (1,'A','B',0,NULL);
INSERT INTO \`wp_posts\` VALUES (2,'C','D',0,NULL);
# don't panic
/* isn't it */
INSERT INTO \`wp_posts\` VALUES (3,'E','F',0,NULL);
`
  );
  assert.equal(stats.rows, 3);
  const n = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM wp_posts').get();
  assert.equal(n?.n, 3);
});

test('convertDump: `--` inside a value, and unspaced `--` starts no comment', (t) => {
  const { db, stats } = convert(
    t,
    `${POSTS_DDL}
INSERT INTO \`wp_posts\` VALUES (1,'a -- b','c',5--2,NULL);
`
  );
  assert.equal(stats.rows, 1);
  const row = db
    .prepare<{ post_title: string; menu_order: string }>(
      'SELECT post_title, menu_order FROM wp_posts'
    )
    .get();
  assert.equal(row?.post_title, 'a -- b');
  // `--` without trailing whitespace is not a comment, so the rest of the
  // row survives. mysqldump writes literals only; an arithmetic expression
  // is stored verbatim rather than evaluated (SQL would make this 7).
  assert.equal(row?.menu_order, '5--2');
});

test('convertDump: honours a named column list', (t) => {
  const { db, stats } = convert(
    t,
    `${POSTS_DDL}
INSERT INTO \`wp_posts\` (\`ID\`,\`post_content\`,\`post_title\`) VALUES (1,'C-VAL','T-VAL');
INSERT INTO \`wp_posts\` (ID,post_content,post_title) VALUES (2,'C2','T2');
`
  );
  assert.equal(stats.rows, 2);
  const rows = db
    .prepare<{ ID: number; post_title: string; post_content: string }>(
      'SELECT ID, post_title, post_content FROM wp_posts ORDER BY ID'
    )
    .all();
  assert.equal(rows[0]?.post_title, 'T-VAL');
  assert.equal(rows[0]?.post_content, 'C-VAL');
  assert.equal(rows[1]?.post_title, 'T2');
  assert.equal(rows[1]?.post_content, 'C2');
});

test('convertDump: drops whitespace around quoted values but keeps it inside', (t) => {
  const { db, stats } = convert(
    t,
    `${POSTS_DDL}
INSERT INTO \`wp_posts\` VALUES ( 1, ' x ' , '  y
z  ' , 0 , 1.5 );
`
  );
  assert.equal(stats.rows, 1);
  const row = db
    .prepare<{ ID: number; post_title: string; post_content: string; ratio: number }>(
      'SELECT ID, post_title, post_content, ratio FROM wp_posts'
    )
    .get();
  assert.equal(row?.ID, 1);
  assert.equal(row?.post_title, ' x ');
  assert.equal(row?.post_content, '  y\nz  ');
  assert.equal(row?.ratio, 1.5);
});

test('convertDump: throws on an INSERT it cannot parse', (t) => {
  const dir = tmpdir(t);
  const sqlPath = path.join(dir, 'dump.sql');
  fs.writeFileSync(sqlPath, `${POSTS_DDL}\nINSERT INTO \`wp_posts\` VALUES 1,2,3;\n`);
  assert.throws(
    () => convertDump(sqlPath, path.join(dir, 'out.db')),
    /unparseable INSERT INTO `wp_posts`/
  );
});

test('convertDump: INSERT IGNORE and REPLACE INTO load rows', (t) => {
  const { db, stats } = convert(
    t,
    `${POSTS_DDL}
INSERT IGNORE INTO \`wp_posts\` VALUES (1,'A','B',0,NULL);
REPLACE INTO \`wp_posts\` VALUES (2,'C','D',0,NULL);
INSERT LOW_PRIORITY IGNORE INTO \`wp_posts\` VALUES (3,'E','F',0,NULL);
`
  );
  assert.equal(stats.rows, 3);
  const ids = db.prepare<{ ID: number }>('SELECT ID FROM wp_posts ORDER BY ID').all();
  assert.deepEqual(
    ids.map((r) => r.ID),
    [1, 2, 3]
  );
});

test('convertDump: throws on an unparseable REPLACE rather than skipping it', (t) => {
  const dir = tmpdir(t);
  const sqlPath = path.join(dir, 'dump.sql');
  fs.writeFileSync(sqlPath, `${POSTS_DDL}\nREPLACE INTO \`wp_posts\` SELECT * FROM other;\n`);
  assert.throws(
    () => convertDump(sqlPath, path.join(dir, 'out.db')),
    /unparseable INSERT INTO `wp_posts`/
  );
});

test('convertDump: throws on an unterminated block comment', (t) => {
  const dir = tmpdir(t);
  const sqlPath = path.join(dir, 'dump.sql');
  fs.writeFileSync(sqlPath, `${POSTS_DDL}\n/* truncated here\nINSERT INTO \`wp_posts\` VALUES (1,`);
  assert.throws(() => convertDump(sqlPath, path.join(dir, 'out.db')), /truncated/);
});

test('convertDump: throws on an INSERT with no VALUES clause', (t) => {
  const dir = tmpdir(t);
  const sqlPath = path.join(dir, 'dump.sql');
  fs.writeFileSync(sqlPath, `${POSTS_DDL}\nINSERT INTO \`wp_posts\` SELECT * FROM other;\n`);
  assert.throws(
    () => convertDump(sqlPath, path.join(dir, 'out.db')),
    /unparseable INSERT INTO `wp_posts`/
  );
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
