// fix-wp-dates: repair WP-imported post frontmatter by restoring the
// original publication date from the filename prefix (YYYY-MM-DD-slug.md).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import fixWpDatesCmd, { fixWpDates } from '../../src/cli/fix-wp-dates.ts';
import { runReindex } from '../../src/cli/reindex.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-fix-wp-'));
  for (const sub of ['content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeWpPost(root: string, filename: string, date: string): void {
  const content = `---
title: "Test Post"
slug: test-post
date: ${date}
status: published
source_url: https://example.wordpress.com/test-post/
source_kind: wordpress
---

Body text.
`;
  fs.writeFileSync(path.join(root, 'content', 'posts', filename), content, 'utf8');
}

function writeEditorPost(root: string, filename: string, date: string): void {
  const content = `---
title: "Editor Post"
slug: editor-post
date: ${date}
status: published
---

Body text.
`;
  fs.writeFileSync(path.join(root, 'content', 'posts', filename), content, 'utf8');
}

test('fixWpDates: restores corrupted date from filename prefix', (t) => {
  const root = freshSiteRoot(t);
  // Filename says 2024-03-15, but frontmatter says today (corrupted by editor save).
  writeWpPost(root, '2024-03-15-test-post.md', '2026-05-14T00:00:00.000Z');

  const report = fixWpDates(root);
  assert.equal(report.fixed, 1);
  assert.equal(report.skipped, 0);

  const raw = fs.readFileSync(
    path.join(root, 'content', 'posts', '2024-03-15-test-post.md'),
    'utf8'
  );
  assert.match(raw, /^date: 2024-03-15/m);
  assert.doesNotMatch(raw, /2026-05-14/);
});

test('fixWpDates: skips posts whose date already matches filename', (t) => {
  const root = freshSiteRoot(t);
  writeWpPost(root, '2024-03-15-test-post.md', '2024-03-15T12:00:00Z');

  const report = fixWpDates(root);
  assert.equal(report.fixed, 0);
  assert.equal(report.skipped, 1);
});

test('fixWpDates: ignores non-WP posts (no source_kind: wordpress)', (t) => {
  const root = freshSiteRoot(t);
  writeEditorPost(root, '2024-03-15-editor-post.md', '2026-05-14T00:00:00.000Z');

  const report = fixWpDates(root);
  assert.equal(report.fixed, 0);
  assert.equal(report.skipped, 0);

  // File unchanged.
  const raw = fs.readFileSync(
    path.join(root, 'content', 'posts', '2024-03-15-editor-post.md'),
    'utf8'
  );
  assert.match(raw, /2026-05-14/);
});

test('fixWpDates: ignores posts with no date prefix in filename', (t) => {
  const root = freshSiteRoot(t);
  // slug-only filename (editor-created post)
  const content = `---
title: "No Date File"
slug: no-date-file
date: 2026-05-14T00:00:00.000Z
status: published
source_kind: wordpress
---

Body.
`;
  fs.writeFileSync(path.join(root, 'content', 'posts', 'no-date-file.md'), content, 'utf8');

  const report = fixWpDates(root);
  assert.equal(report.fixed, 0);
});

test('fixWpDates: returns empty report when posts dir does not exist', (t) => {
  const root = freshSiteRoot(t);
  // Pass a siteRoot whose content/posts dir doesn't exist.
  const report = fixWpDates(path.join(root, 'nonexistent'));
  assert.deepEqual(report, { fixed: 0, skipped: 0, errors: [] });
});

test('fixWpDatesCmd: prints summary and exits cleanly', async (t) => {
  const root = freshSiteRoot(t);
  writeWpPost(root, '2024-03-15-test-post.md', '2026-05-14T00:00:00.000Z');

  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  t.after(() => {
    console.log = origLog;
  });

  await fixWpDatesCmd([root]);
  assert.ok(lines.some((l) => l.includes('Fixed: 1')));
  assert.ok(lines.some((l) => l.includes('reindex')));
});

test('fixWpDatesCmd: no reindex hint when nothing fixed', async (t) => {
  const root = freshSiteRoot(t);
  writeWpPost(root, '2024-03-15-test-post.md', '2024-03-15T12:00:00Z');

  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  t.after(() => {
    console.log = origLog;
  });

  await fixWpDatesCmd([root]);
  assert.ok(lines.some((l) => l.includes('Fixed: 0')));
  assert.ok(!lines.some((l) => l.includes('reindex')));
});

test('fixWpDates: reindex after fix reflects corrected published_at', (t) => {
  const root = freshSiteRoot(t);
  writeWpPost(root, '2024-03-15-test-post.md', '2026-05-14T00:00:00.000Z');

  fixWpDates(root);

  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  runReindex(root);

  const row = db
    .prepare<{ published_at: string }>('SELECT published_at FROM posts WHERE slug = ?')
    .get('test-post');
  assert.ok(row, 'post row should exist');
  assert.ok(
    row!.published_at.startsWith('2024-03-15'),
    `expected 2024-03-15, got ${row!.published_at}`
  );
});
