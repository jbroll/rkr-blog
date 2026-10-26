import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import blocksMigrateCmd, {
  runBlocksArchive,
  runBlocksMigrate,
  runBlocksMigrateAll
} from '../../src/cli/blocks-migrate.ts';
import { open } from '../../src/lib/db.ts';
import { readIndexedPostBySlug, runReindex } from '../../src/lib/post-index.ts';

function withSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-blocks-migrate-'));
  fs.mkdirSync(path.join(root, 'content', 'posts'), { recursive: true });
  const prev = process.env.SITE_ROOT;
  process.env.SITE_ROOT = root;
  t.after(() => {
    if (prev === undefined) delete process.env.SITE_ROOT;
    else process.env.SITE_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function writePost(root: string, filename: string, body: string): void {
  fs.writeFileSync(path.join(root, 'content', 'posts', filename), body);
}

function writeTwin(root: string, filename: string, slug: string, title = 'T'): void {
  const blocksDir = path.join(root, 'content', 'blocks');
  fs.mkdirSync(blocksDir, { recursive: true });
  fs.writeFileSync(
    path.join(blocksDir, filename),
    JSON.stringify({
      version: 1,
      body: [{ type: 'text', markdown: 'json body' }],
      fields: { title, slug, status: 'published', date: '2026-01-15T12:00:00Z' }
    })
  );
}

function commentCount(root: string, slug: string): number {
  const db = open(path.join(root, 'data', 'site.db'));
  try {
    const row = db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM comments').get();
    assert.ok(readIndexedPostBySlug(db, slug), `post ${slug} must stay indexed`);
    return row?.c ?? 0;
  } finally {
    db.close();
  }
}

const POST = `---
title: T
slug: t
status: published
date: 2026-01-15T12:00:00Z
---

Hello world.

::figure{ids="ab12cd"}
`;

describe('blocks-migrate', () => {
  it('converts a markdown post to a JSON tree', (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 't.md', POST);
    const tree = runBlocksMigrate(root, 't');
    assert.equal(tree.fields.slug, 't');
    assert.equal(tree.body[0]?.type, 'text');
    assert.equal(tree.body[1]?.type, 'figure');
  });

  it('throws for a missing post', (t: TestContext) => {
    const root = withSiteRoot(t);
    assert.throws(() => runBlocksMigrate(root, 'nope'), /no post with slug/);
  });

  it('default export exits 2 with usage when --post has no slug', async (t: TestContext) => {
    withSiteRoot(t);
    const errors: string[] = [];
    t.mock.method(console, 'error', (...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });
    t.mock.method(process, 'exit', (code?: number) => {
      throw new Error(`exit ${code}`);
    });
    await assert.rejects(blocksMigrateCmd(['--post']), /exit 2/);
    assert.match(errors.join('\n'), /usage: site-admin blocks-migrate/);
  });

  it('default export writes pretty JSON to a file', async (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 't.md', POST);
    const out = path.join(root, 't.json');
    await blocksMigrateCmd(['--post', 't', '--out', out]);
    const parsed = JSON.parse(fs.readFileSync(out, 'utf8')) as { version: number };
    assert.equal(parsed.version, 1);
  });

  it('converts every post with --all, mirroring markdown basenames', (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, '2026-01-15-t.md', POST);
    writePost(root, 'u.md', POST.replace('slug: t', 'slug: u').replace('title: T', 'title: U'));
    const written = runBlocksMigrateAll(root);
    assert.equal(written.length, 2);
    assert.ok(fs.existsSync(path.join(root, 'content', 'blocks', '2026-01-15-t.json')));
    assert.ok(fs.existsSync(path.join(root, 'content', 'blocks', 'u.json')));
    for (const f of written) {
      const text = fs.readFileSync(f.file, 'utf8');
      assert.doesNotMatch(text, /"type": "(flow|section|row|col)"/);
    }
  });

  it('archive moves markdown out of the read path and reindex keeps the slug', (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 't.md', POST);
    writeTwin(root, 't.json', 't');

    // Pre-cutover index: the post is indexed and has a comment thread.
    runReindex(root);
    const db = open(path.join(root, 'data', 'site.db'));
    const post = db.prepare<{ id: number }>('SELECT id FROM posts WHERE slug = ?').get('t');
    assert.ok(post);
    db.prepare(
      `INSERT INTO comments
         (post_id, parent_id, wp_comment_id, author_name, author_email,
          body, status, source, created_at)
       VALUES (?,NULL,NULL,?,?,?,?,?,?)`
    ).run(
      post.id,
      'Alice',
      'alice@example.com',
      'Still here?',
      'published',
      'web',
      new Date().toISOString()
    );
    db.close();

    const moved = runBlocksArchive(root);
    assert.deepEqual(
      moved.map((m) => m.slug),
      ['t']
    );
    assert.equal(fs.existsSync(path.join(root, 'content', 'posts', 't.md')), false);
    assert.ok(fs.existsSync(path.join(root, 'content', 'posts-legacy', 't.md')));
    assert.ok(fs.existsSync(path.join(root, 'content', 'blocks', 't.json')), 'twin stays in place');

    runReindex(root);
    assert.equal(commentCount(root, 't'), 1, 'comment thread survives the archive');

    const db2 = open(path.join(root, 'data', 'site.db'));
    try {
      const row = readIndexedPostBySlug(db2, 't');
      assert.match(row?.path ?? '', /^content\/blocks\//, 'row now points at the JSON source');
    } finally {
      db2.close();
    }
  });

  it('archive leaves _-prefixed system files live in content/posts', (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 't.md', POST);
    writePost(
      root,
      '_about.md',
      '---\ntitle: About\nslug: _about\nstatus: published\n---\n\nAbout body.\n'
    );
    writePost(
      root,
      '_site-banner.md',
      '---\ntitle: Banner\nslug: _site-banner\nstatus: published\n---\n\nBanner body.\n'
    );
    writeTwin(root, 't.json', 't');

    const moved = runBlocksArchive(root);
    assert.equal(moved.length, 1);
    assert.ok(fs.existsSync(path.join(root, 'content', 'posts', '_about.md')));
    assert.ok(fs.existsSync(path.join(root, 'content', 'posts', '_site-banner.md')));
    assert.equal(fs.existsSync(path.join(root, 'content', 'posts-legacy', '_about.md')), false);
    assert.equal(
      fs.existsSync(path.join(root, 'content', 'posts-legacy', '_site-banner.md')),
      false
    );
  });

  it('archive refuses untwinned markdown unless --include-untwinned', (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 't.md', POST);
    writeTwin(root, 't.json', 't');
    writePost(root, 'loose.md', POST.replace('slug: t', 'slug: loose'));

    assert.throws(() => runBlocksArchive(root), /no JSON twin.*loose/);
    assert.ok(fs.existsSync(path.join(root, 'content', 'posts', 'loose.md')), 'nothing moved');
    assert.ok(fs.existsSync(path.join(root, 'content', 'posts', 't.md')), 'nothing moved');

    const moved = runBlocksArchive(root, { includeUntwinned: true });
    assert.deepEqual(
      moved.map((m) => m.slug),
      ['loose', 't']
    );
    assert.equal(fs.existsSync(path.join(root, 'content', 'posts', 'loose.md')), false);
    assert.ok(fs.existsSync(path.join(root, 'content', 'posts-legacy', 'loose.md')));
  });

  it('default export archives with --archive', async (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 't.md', POST);
    writeTwin(root, 't.json', 't');

    await blocksMigrateCmd(['--archive']);
    assert.equal(fs.existsSync(path.join(root, 'content', 'posts', 't.md')), false);
    assert.ok(fs.existsSync(path.join(root, 'content', 'posts-legacy', 't.md')));
  });

  it('archive refuses to overwrite an existing legacy file', (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 't.md', POST);
    writeTwin(root, 't.json', 't');
    runBlocksArchive(root);

    // A new markdown source with the same name must not clobber the archive.
    writePost(root, 't.md', POST);
    assert.throws(() => runBlocksArchive(root), /already archived: t\.md/);
    assert.ok(fs.existsSync(path.join(root, 'content', 'posts', 't.md')), 'new source stays put');
    assert.ok(fs.existsSync(path.join(root, 'content', 'posts-legacy', 't.md')));
  });

  it('archive ignores corrupt JSON files when matching twins', (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 't.md', POST);
    writeTwin(root, 't.json', 't');
    fs.writeFileSync(path.join(root, 'content', 'blocks', 'corrupt.json'), '{not json');

    const moved = runBlocksArchive(root);
    assert.equal(moved.length, 1);
    assert.ok(fs.existsSync(path.join(root, 'content', 'blocks', 'corrupt.json')));
  });

  it('default export converts every post with --all', async (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 't.md', POST);
    await blocksMigrateCmd(['--all']);
    assert.ok(fs.existsSync(path.join(root, 'content', 'blocks', 't.json')));
  });

  it('--all skips a post that cannot be converted and writes the rest', (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 't.md', POST);
    writePost(root, 'bad.md', 'no frontmatter here');
    const written = runBlocksMigrateAll(root);
    assert.deepEqual(
      written.map((w) => w.slug),
      ['t']
    );
    assert.equal(fs.existsSync(path.join(root, 'content', 'blocks', 'bad.json')), false);
  });

  it('--all leaves an existing twin alone unless forced', (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 't.md', POST);
    writeTwin(root, 'edited.json', 't', 'Edited in the editor');
    const before = fs.readFileSync(path.join(root, 'content', 'blocks', 'edited.json'), 'utf8');

    assert.deepEqual(runBlocksMigrateAll(root, { log: () => {} }), []);
    assert.equal(
      fs.readFileSync(path.join(root, 'content', 'blocks', 'edited.json'), 'utf8'),
      before
    );
    assert.equal(fs.existsSync(path.join(root, 'content', 'blocks', 't.json')), false);

    const forced = runBlocksMigrateAll(root, { force: true, log: () => {} });
    assert.deepEqual(
      forced.map((w) => w.slug),
      ['t']
    );
    const replaced = JSON.parse(
      fs.readFileSync(path.join(root, 'content', 'blocks', 'edited.json'), 'utf8')
    ) as { fields: { title: string } };
    assert.equal(replaced.fields.title, 'T', 'force replaces the file the slug resolves to');
    assert.equal(fs.existsSync(path.join(root, 'content', 'blocks', 't.json')), false);
  });

  it('--all never writes _-prefixed system posts', (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 't.md', POST);
    writePost(root, '_about.md', '---\ntitle: About\nslug: _about\n---\n\nAbout.\n');
    writePost(root, '_site-banner.md', '---\ntitle: B\nslug: _site-banner\n---\n\nB.\n');
    const written = runBlocksMigrateAll(root, { log: () => {} });
    assert.deepEqual(
      written.map((w) => w.slug),
      ['t']
    );
    assert.deepEqual(fs.readdirSync(path.join(root, 'content', 'blocks')), ['t.json']);
  });

  it('--all --dry-run lists what it would write and writes nothing', async (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 't.md', POST);
    const lines: string[] = [];
    t.mock.method(console, 'log', (...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    });
    await blocksMigrateCmd(['--all', '--dry-run']);
    assert.equal(fs.existsSync(path.join(root, 'content', 'blocks', 't.json')), false);
    assert.match(lines.join('\n'), /would write 1 JSON twin/);
    assert.match(lines.join('\n'), /t\.json/);
  });

  it('--all warns about slugs a fixed route answers', (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 'search.md', POST.replace('slug: t', 'slug: search'));
    writePost(root, 'new.md', POST.replace('slug: t', 'slug: new'));
    const warnings: string[] = [];
    runBlocksMigrateAll(root, { log: (m) => warnings.push(m) });
    assert.match(warnings.join('\n'), /"new".*reserved/);
    assert.match(warnings.join('\n'), /"search".*reserved/);
  });

  it('--all dates an undated post from its file and keeps its mtime', (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 'u.md', '---\ntitle: U\nslug: u\nstatus: published\n---\n\nUndated.\n');
    const mtime = new Date('2019-03-04T05:06:07.890Z');
    fs.utimesSync(path.join(root, 'content', 'posts', 'u.md'), mtime, mtime);
    runReindex(root);
    const db = open(path.join(root, 'data', 'site.db'));
    const before = readIndexedPostBySlug(db, 'u')?.published_at;
    db.close();

    runBlocksMigrateAll(root, { log: () => {} });
    const twin = path.join(root, 'content', 'blocks', 'u.json');
    const parsed = JSON.parse(fs.readFileSync(twin, 'utf8')) as { fields: { date?: string } };
    assert.equal(parsed.fields.date, '2019-03-04T05:06:07Z');
    assert.equal(fs.statSync(twin).mtimeMs, mtime.getTime());

    runBlocksArchive(root);
    runReindex(root);
    const db2 = open(path.join(root, 'data', 'site.db'));
    try {
      const row = readIndexedPostBySlug(db2, 'u');
      assert.equal(row?.published_at?.slice(0, 19), before?.slice(0, 19));
      assert.equal(row?.updated_at, mtime.toISOString());
    } finally {
      db2.close();
    }
  });

  it('--archive --dry-run moves nothing', async (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 't.md', POST);
    writeTwin(root, 't.json', 't');
    const lines: string[] = [];
    t.mock.method(console, 'log', (...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    });
    await blocksMigrateCmd(['--archive', '--dry-run']);
    assert.ok(fs.existsSync(path.join(root, 'content', 'posts', 't.md')));
    assert.equal(fs.existsSync(path.join(root, 'content', 'posts-legacy')), false);
    assert.match(lines.join('\n'), /would move 1 markdown file/);
  });

  it('archive treats a twin the index would skip as no twin', (t: TestContext) => {
    const root = withSiteRoot(t);
    writePost(root, 'a.md', POST.replace('slug: t', 'slug: a'));
    writePost(root, 'b.md', POST.replace('slug: t', 'slug: b'));
    const blocksDir = path.join(root, 'content', 'blocks');
    fs.mkdirSync(blocksDir, { recursive: true });
    fs.writeFileSync(
      path.join(blocksDir, 'a.json'),
      JSON.stringify({ version: 1, body: [{ type: 'mystery' }], fields: { title: 'A', slug: 'a' } })
    );
    fs.writeFileSync(
      path.join(blocksDir, 'b.json'),
      JSON.stringify({ version: 1, body: [], fields: { slug: 'b' } })
    );
    assert.throws(() => runBlocksArchive(root), /no JSON twin for a \(a\.md\), b \(b\.md\)/);
    assert.ok(fs.existsSync(path.join(root, 'content', 'posts', 'a.md')));
  });
});
