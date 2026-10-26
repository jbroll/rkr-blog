import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import importWpCmd from '../../src/cli/import-wp.ts';
import { open } from '../../src/lib/db.ts';

function withSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-wp-blocks-'));
  for (const sub of ['content/posts', 'content/blocks', 'data', 'sidecars', 'originals']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  const prev = process.env.SITE_ROOT;
  process.env.SITE_ROOT = root;
  t.after(() => {
    if (prev === undefined) delete process.env.SITE_ROOT;
    else process.env.SITE_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function seedDump(t: TestContext): { dbPath: string; uploadsRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-wp-dump-'));
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
      comment_content TEXT, comment_approved TEXT, comment_type TEXT DEFAULT '',
      comment_parent INTEGER);
    INSERT INTO wp_posts (ID, post_date, post_modified, post_content, post_title,
      post_excerpt, post_status, post_name, post_type)
    VALUES (7, '2026-03-01 12:00:00', '2026-03-01 12:00:00',
      '<p>Hello <strong>world</strong>.</p>', 'Hello', '', 'publish', 'hello', 'post');
  `);
  db.close();
  const uploadsRoot = path.join(root, 'uploads');
  fs.mkdirSync(uploadsRoot);
  return { dbPath, uploadsRoot };
}

describe('import-wp post --as-blocks', () => {
  it('writes the markdown post and a JSON twin', async (t: TestContext) => {
    const root = withSiteRoot(t);
    const dump = seedDump(t);
    await importWpCmd([
      'post',
      'https://wp.example',
      'hello',
      '--from-dump',
      dump.dbPath,
      '--uploads',
      dump.uploadsRoot,
      '--as-blocks'
    ]);
    const md = fs.readdirSync(path.join(root, 'content', 'posts'));
    assert.ok(
      md.some((f) => f.endsWith('-hello.md')),
      `posts: ${md.join(',')}`
    );
    const jsonFiles = fs.readdirSync(path.join(root, 'content', 'blocks'));
    assert.ok(
      jsonFiles.some((f) => f.endsWith('-hello.json')),
      `blocks: ${jsonFiles.join(',')}`
    );
    const tree = JSON.parse(
      fs.readFileSync(
        path.join(root, 'content', 'blocks', jsonFiles.find((f) => f.endsWith('.json')) as string),
        'utf8'
      )
    ) as { version: number; fields: { slug: string }; body: { type: string }[] };
    assert.equal(tree.version, 1);
    assert.equal(tree.fields.slug, 'hello');
    assert.equal(tree.body[0]?.type, 'grid');
  });
});
