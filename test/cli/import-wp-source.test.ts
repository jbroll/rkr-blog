// resolveSource: the --from-dump / --uploads flag pair selects the
// backup source; without them the REST source is used.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { resolveSource } from '../../src/cli/import-wp.ts';
import { open } from '../../src/lib/db.ts';

function emptyBackup(t: TestContext): { dbPath: string; uploadsRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-wp-src-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'wp.db');
  const db = open(dbPath);
  db.exec(`
    CREATE TABLE wp_posts (ID INTEGER PRIMARY KEY, post_date TEXT, post_modified TEXT,
      post_content TEXT, post_title TEXT, post_excerpt TEXT, post_status TEXT,
      post_name TEXT, post_type TEXT);
    CREATE TABLE wp_postmeta (post_id INTEGER, meta_key TEXT, meta_value TEXT);
    CREATE TABLE wp_terms (term_id INTEGER PRIMARY KEY, name TEXT, slug TEXT);
    CREATE TABLE wp_term_taxonomy (term_taxonomy_id INTEGER PRIMARY KEY, term_id INTEGER, taxonomy TEXT);
    CREATE TABLE wp_term_relationships (object_id INTEGER, term_taxonomy_id INTEGER);
    CREATE TABLE wp_options (option_name TEXT, option_value TEXT);
    CREATE TABLE wp_comments (comment_ID INTEGER PRIMARY KEY, comment_post_ID INTEGER,
      comment_author TEXT, comment_author_url TEXT, comment_date TEXT,
      comment_content TEXT, comment_approved TEXT, comment_parent INTEGER);
  `);
  db.close();
  const uploadsRoot = path.join(root, 'uploads');
  fs.mkdirSync(uploadsRoot);
  return { dbPath, uploadsRoot };
}

test('resolveSource: --from-dump selects the backup source', async (t) => {
  const fix = emptyBackup(t);
  const source = resolveSource(
    ['--from-dump', fix.dbPath, '--uploads', fix.uploadsRoot],
    'https://wp.example'
  );
  t.after(() => source.close());
  const r = await source.listPosts();
  assert.equal(r.total, 0);
});

test('resolveSource: --from-dump without --uploads is an error', (t) => {
  const fix = emptyBackup(t);
  assert.throws(
    () => resolveSource(['--from-dump', fix.dbPath], 'https://wp.example'),
    /--uploads <dir> is required/
  );
});

test('resolveSource: no flags yields the REST source', () => {
  const source = resolveSource([], 'https://wp.example');
  assert.equal(typeof source.listPosts, 'function');
  source.close();
});
