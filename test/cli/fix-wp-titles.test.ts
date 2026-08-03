// fix-wp-titles: decode HTML entities left in the frontmatter titles of
// posts imported before the WP importer decoded them.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import fixWpTitlesCmd, { fixWpTitles } from '../../src/cli/fix-wp-titles.ts';
import { parsePost } from '../../src/lib/content.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-fix-titles-'));
  fs.mkdirSync(path.join(root, 'content', 'posts'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

interface PostFields {
  title: string;
  subtitle?: string;
  /** null writes no source_kind line at all — the shape /admin/posts writes. */
  sourceKind?: string | null;
}

function writePost(root: string, filename: string, fields: PostFields): string {
  const lines = ['---', `title: "${fields.title}"`];
  if (fields.subtitle !== undefined) lines.push(`subtitle: "${fields.subtitle}"`);
  lines.push('slug: a-post', 'date: "2026-05-18T00:00:00Z"', 'status: published');
  if (fields.sourceKind !== null) lines.push(`source_kind: ${fields.sourceKind ?? 'wordpress'}`);
  lines.push('---', '', 'Body with a literal &#8211; that must not be touched.', '');
  const full = path.join(root, 'content', 'posts', filename);
  fs.writeFileSync(full, lines.join('\n'), 'utf8');
  return full;
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

test('decodes numeric entities in a WP-imported title', (t) => {
  const root = freshSiteRoot(t);
  const file = writePost(root, '2026-05-18-a-post.md', {
    title: 'Day 12 &#8211; 31 Years!'
  });

  const report = fixWpTitles(root);

  assert.equal(report.fixed, 1);
  assert.equal(report.skipped, 0);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.changes, [
    {
      file: '2026-05-18-a-post.md',
      field: 'title',
      from: 'Day 12 &#8211; 31 Years!',
      to: 'Day 12 – 31 Years!'
    }
  ]);
  assert.match(read(file), /^title: "Day 12 – 31 Years!"$/m);
});

test('decodes curly quotes, ellipsis and hex entities', (t) => {
  const root = freshSiteRoot(t);
  const a = writePost(root, 'a.md', { title: 'Picking Up the Scamp at the &#8220;Nest&#8221;' });
  const b = writePost(root, 'b.md', { title: 'A sweet reminder&#8230;' });
  const c = writePost(root, 'c.md', { title: 'Caf&#xe9; stop' });

  const report = fixWpTitles(root);

  assert.equal(report.fixed, 3);
  assert.match(read(a), /^title: "Picking Up the Scamp at the “Nest”"$/m);
  assert.match(read(b), /^title: "A sweet reminder…"$/m);
  assert.match(read(c), /^title: "Café stop"$/m);
});

test('decodes a subtitle too', (t) => {
  const root = freshSiteRoot(t);
  const file = writePost(root, 'a.md', {
    title: 'Plain title',
    subtitle: 'and a subtitle&#8230;'
  });

  const report = fixWpTitles(root);

  assert.equal(report.fixed, 1);
  assert.match(read(file), /^subtitle: "and a subtitle…"$/m);
});

test('re-escapes a decoded quote so the YAML stays parseable', (t) => {
  const root = freshSiteRoot(t);
  const file = writePost(root, 'a.md', { title: 'He said &quot;hi&quot;' });

  fixWpTitles(root);

  const parsed = parsePost(read(file));
  assert.equal(parsed.frontmatter.title, 'He said "hi"');
});

test('leaves a title with no entities alone', (t) => {
  const root = freshSiteRoot(t);
  const file = writePost(root, 'a.md', { title: 'Already clean — really' });
  const before = read(file);

  const report = fixWpTitles(root);

  assert.equal(report.fixed, 0);
  assert.equal(report.skipped, 1);
  assert.equal(read(file), before);
});

test('never touches the post body', (t) => {
  const root = freshSiteRoot(t);
  const file = writePost(root, 'a.md', { title: 'Day 12 &#8211; 31 Years!' });

  fixWpTitles(root);

  assert.match(read(file), /Body with a literal &#8211; that must not be touched\./);
});

test('repairs posts with no source_kind — pushed posts carry no provenance', (t) => {
  const root = freshSiteRoot(t);
  const file = writePost(root, 'a.md', {
    title: 'Day 12 &#8211; 31 Years!',
    sourceKind: null
  });

  const report = fixWpTitles(root);

  assert.equal(report.fixed, 1);
  assert.match(read(file), /^title: "Day 12 – 31 Years!"$/m);
});

test('dry run reports what it would change without writing', (t) => {
  const root = freshSiteRoot(t);
  const file = writePost(root, 'a.md', { title: 'Day 12 &#8211; 31 Years!' });
  const before = read(file);

  const report = fixWpTitles(root, { dryRun: true });

  assert.equal(report.fixed, 1);
  assert.equal(read(file), before);
});

test('leaves an out-of-range codepoint literal rather than throwing', (t) => {
  const root = freshSiteRoot(t);
  const file = writePost(root, 'a.md', { title: 'Bad &#1114112; entity' });

  const report = fixWpTitles(root);

  assert.equal(report.fixed, 0);
  assert.match(read(file), /^title: "Bad &#1114112; entity"$/m);
});

test('returns an empty report when the posts directory is missing', (t) => {
  const root = freshSiteRoot(t);
  fs.rmSync(path.join(root, 'content', 'posts'), { recursive: true });

  const report = fixWpTitles(root);

  assert.deepEqual(report, { fixed: 0, skipped: 0, errors: [], changes: [] });
});

test('CLI entry point runs against a site root argument', async (t) => {
  const root = freshSiteRoot(t);
  const file = writePost(root, 'a.md', { title: 'Day 12 &#8211; 31 Years!' });
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.join(' '));
  };
  t.after(() => {
    console.log = realLog;
  });

  await fixWpTitlesCmd([root]);

  assert.match(read(file), /^title: "Day 12 – 31 Years!"$/m);
  assert.ok(
    logged.some((l) => l.includes('Fixed: 1')),
    `expected a summary line, got ${JSON.stringify(logged)}`
  );
});

test('CLI entry point honours --dry-run', async (t) => {
  const root = freshSiteRoot(t);
  const file = writePost(root, 'a.md', { title: 'Day 12 &#8211; 31 Years!' });
  const before = read(file);
  const realLog = console.log;
  console.log = () => {};
  t.after(() => {
    console.log = realLog;
  });

  await fixWpTitlesCmd([root, '--dry-run']);

  assert.equal(read(file), before);
});
