import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { readIndexedPostBySlug, runReindex } from '../../src/lib/post-index.ts';

function freshRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-post-index-blocks-'));
  for (const sub of ['content/posts', 'content/blocks', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeMd(root: string, filename: string, slug: string, title: string): void {
  fs.writeFileSync(
    path.join(root, 'content', 'posts', filename),
    `---\nslug: ${slug}\ntitle: ${title}\nstatus: published\ndate: 2026-01-15T12:00:00Z\n---\n\nmarkdown body\n`
  );
}

function writeJson(
  root: string,
  filename: string,
  fields: Record<string, unknown>,
  body: unknown[] = [{ type: 'text', markdown: 'json body' }]
): void {
  fs.writeFileSync(
    path.join(root, 'content', 'blocks', filename),
    JSON.stringify({ version: 1, body, fields })
  );
}

function indexedTitle(root: string, slug: string): string | undefined {
  const db = open(path.join(root, 'data', 'site.db'));
  try {
    return readIndexedPostBySlug(db, slug)?.title;
  } finally {
    db.close();
  }
}

describe('post kind', () => {
  it('a page file indexes with kind page; absent kind indexes as post', (t: TestContext) => {
    const root = freshRoot(t);
    const base = { title: 'T', status: 'published', date: '2026-01-15T12:00:00Z' };
    writeJson(root, 'a.json', { ...base, slug: 'a', kind: 'page' });
    writeJson(root, 'b.json', { ...base, slug: 'b' });
    writeMd(root, 'c.md', 'c', 'C');
    runReindex(root);
    const db = open(path.join(root, 'data', 'site.db'));
    try {
      assert.equal(readIndexedPostBySlug(db, 'a')?.kind, 'page');
      assert.equal(readIndexedPostBySlug(db, 'b')?.kind, 'post');
      assert.equal(readIndexedPostBySlug(db, 'c')?.kind, 'post');
      writeJson(root, 'a.json', { ...base, slug: 'a' });
      runReindex(root);
      assert.equal(readIndexedPostBySlug(db, 'a')?.kind, 'post');
      writeMd(root, 'd.md', 'd', 'D');
      writeJson(root, 'd.json', { ...base, slug: 'd', kind: 'page' });
      runReindex(root);
      assert.equal(readIndexedPostBySlug(db, 'd')?.kind, 'page');
      writeJson(root, 'd.json', { ...base, slug: 'd', kind: 'page', title: 'D2' });
      fs.rmSync(path.join(root, 'content', 'posts', 'd.md'));
      runReindex(root);
      assert.equal(readIndexedPostBySlug(db, 'd')?.kind, 'page');
    } finally {
      db.close();
    }
  });
});

describe('post index with JSON twins', () => {
  it('pairs a JSON twin with its markdown post by slug', (t: TestContext) => {
    const root = freshRoot(t);
    writeMd(root, '2026-01-15-hello.md', 'hello', 'Markdown title');
    writeJson(root, '2026-01-15-hello.json', {
      title: 'JSON title',
      slug: 'hello',
      status: 'published',
      date: '2026-01-15T12:00:00Z'
    });
    const counts = runReindex(root);
    assert.equal(counts.inserted, 1);
    assert.equal(counts.updated, 1);
    assert.equal(indexedTitle(root, 'hello'), 'JSON title');
  });

  it('indexes a JSON-only page', (t: TestContext) => {
    const root = freshRoot(t);
    writeJson(root, 'solo.json', {
      title: 'Solo',
      slug: 'solo',
      status: 'published',
      tags: ['news']
    });
    runReindex(root);
    assert.equal(indexedTitle(root, 'solo'), 'Solo');
  });

  it('skips a corrupt JSON twin and keeps the markdown row', (t: TestContext) => {
    const root = freshRoot(t);
    writeMd(root, 'hello.md', 'hello', 'Markdown title');
    writeJson(root, 'hello.json', { title: 'JSON title', slug: 'hello' }, [{ type: 'nope' }]);
    runReindex(root);
    assert.equal(indexedTitle(root, 'hello'), 'Markdown title');
  });

  it('removing the JSON twin reveals the markdown row again', (t: TestContext) => {
    const root = freshRoot(t);
    writeMd(root, 'hello.md', 'hello', 'Markdown title');
    writeJson(root, 'hello.json', { title: 'JSON title', slug: 'hello', status: 'published' });
    runReindex(root);
    assert.equal(indexedTitle(root, 'hello'), 'JSON title');
    fs.unlinkSync(path.join(root, 'content', 'blocks', 'hello.json'));
    runReindex(root);
    assert.equal(indexedTitle(root, 'hello'), 'Markdown title');
  });

  it('indexes accordion titles and markdown bodies as plain words', (t: TestContext) => {
    const root = freshRoot(t);
    writeJson(root, 'faq.json', { title: 'F', slug: 'faq', status: 'published' }, [
      {
        type: 'accordion',
        slots: { items: [{ title: 'Archive', body: '[Issue one](http://x.example/u)' }, null] }
      }
    ]);
    runReindex(root);
    const db = open(path.join(root, 'data', 'site.db'));
    try {
      const row = db
        .prepare<{ body: string }>('SELECT body FROM posts_fts WHERE slug = ?')
        .get('faq');
      assert.equal(row?.body, 'Archive\nIssue one');
    } finally {
      db.close();
    }
  });

  it('indexes text leaves as plain words, without markdown, URLs or HTML', (t: TestContext) => {
    const root = freshRoot(t);
    writeJson(root, 'plain.json', { title: 'P', slug: 'plain', status: 'published' }, [
      { type: 'text', markdown: '**bold** [link](http://x.example/secret-url)' },
      { type: 'text', markdown: '<div class="raw">tagged</div>' }
    ]);
    runReindex(root);
    const db = open(path.join(root, 'data', 'site.db'));
    try {
      const row = db
        .prepare<{ body: string }>('SELECT body FROM posts_fts WHERE slug = ?')
        .get('plain');
      assert.equal(row?.body, 'bold link');
    } finally {
      db.close();
    }
  });
});
