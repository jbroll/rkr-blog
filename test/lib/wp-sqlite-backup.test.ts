// End-to-end over the real roll-along backup. Skipped when the backup
// tree isn't checked out beside this repo.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { parsePost } from '../../src/lib/content.ts';
import { convertDump } from '../../src/lib/wp-dump.ts';
import { importPost } from '../../src/lib/wp-import.ts';
import { sqliteSource } from '../../src/lib/wp-sqlite.ts';

const BACKUP = path.resolve(import.meta.dirname, '../../../roll-along');
const DUMP = path.join(BACKUP, 'db/rollalong.sql');
const UPLOADS = path.join(BACKUP, 'site/wp-content/uploads');
const have = fs.existsSync(DUMP) && fs.existsSync(UPLOADS);

function siteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-wp-backup-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'data', 'content/posts']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('imports one-final-day from the real backup', { skip: !have }, async (t) => {
  const root = siteRoot(t);
  const dbPath = path.join(root, 'wp.db');
  const stats = convertDump(DUMP, dbPath);
  assert.ok(stats.rows > 8000, `expected a full dump, got ${stats.rows} rows`);

  const source = sqliteSource({ dbPath, uploadsRoot: UPLOADS });
  t.after(() => source.close());

  const published = await source.listPosts({ perPage: 500 });
  assert.equal(published.total, 65);

  const post = await source.fetchPost('one-final-day');
  assert.equal(post.title.rendered, 'One final day');
  assert.equal(post.link, 'https://roll-along.rkroll.com/2026/05/18/one-final-day/');

  const result = await importPost(post, {
    siteRoot: root,
    fetchImage: (url) => source.fetchImage(url),
    fetchTagNames: (ids, link) => source.fetchTagNames(ids, link)
  });
  assert.deepEqual(result.imageErrors, []);
  assert.ok(result.imagesIngested.length > 0, 'expected at least one ingested image');
  assert.equal(result.filename, '2026-05-18-one-final-day.md');
  assert.match(result.markdown, /::figure\{ids="/);

  const parsed = parsePost(result.markdown);
  assert.equal(parsed.frontmatter.slug, 'one-final-day');
  assert.equal(parsed.frontmatter.title, 'One final day');
});

test('the three WP drafts get usable slugs', { skip: !have }, async (t) => {
  const root = siteRoot(t);
  const dbPath = path.join(root, 'wp.db');
  convertDump(DUMP, dbPath);
  const source = sqliteSource({ dbPath, uploadsRoot: UPLOADS });
  t.after(() => source.close());

  const drafts = await source.listPosts({ status: 'draft', perPage: 100 });
  assert.equal(drafts.total, 3);
  for (const d of drafts.posts) {
    assert.match(d.slug, /^[a-z0-9][a-z0-9-]*$/, `bad slug for "${d.title.rendered}"`);
  }
});
