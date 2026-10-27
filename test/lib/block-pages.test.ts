import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  findBlockFile,
  isEditableSlug,
  listBlockPages,
  readBlockPage,
  readIndexedBlockPage,
  SYSTEM_SLUGS
} from '../../src/lib/block-pages.ts';

const PAGE = {
  version: 1,
  body: [{ type: 'grid', children: [{ type: 'text', markdown: 'Hello world.' }] }],
  fields: { title: 'Hello', slug: 'hello' }
};

function withBlocks(t: TestContext, files: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-block-pages-'));
  const dir = path.join(root, 'content', 'blocks');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, json] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof json === 'string' ? json : JSON.stringify(json));
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

describe('block-pages', () => {
  it('reads a page by fields.slug regardless of filename', (t: TestContext) => {
    const root = withBlocks(t, { '2026-01-15-hello.json': PAGE });
    const page = readBlockPage(root, 'hello');
    assert.ok(page);
    assert.equal(page.title, 'Hello');
    assert.equal(page.tree.body[0]?.type, 'grid');
  });

  it('returns null for missing pages and bad slugs', (t: TestContext) => {
    const root = withBlocks(t, { '2026-01-15-hello.json': PAGE });
    assert.equal(readBlockPage(root, 'nope'), null);
    assert.equal(readBlockPage(root, '../hello'), null);
    assert.equal(readBlockPage(root, 'HELLO'), null);
  });

  it('skips corrupt files instead of throwing', (t: TestContext) => {
    const root = withBlocks(t, {
      'a.json': 'not json{{{',
      'b.json': { version: 1, body: [{ type: 'nope' }], fields: { slug: 'bad' } },
      'c.json': PAGE
    });
    const page = readBlockPage(root, 'hello');
    assert.ok(page);
    assert.equal(readBlockPage(root, 'bad'), null);
  });

  it('returns null when the blocks dir is absent', (t: TestContext) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-block-pages-empty-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.equal(readBlockPage(root, 'hello'), null);
  });

  it('lists stored pages sorted by slug', (t: TestContext) => {
    const root = withBlocks(t, {
      'b.json': { ...PAGE, fields: { title: 'Bee', slug: 'b' } },
      'a.json': { ...PAGE, fields: { title: 'Aye', slug: 'a' } }
    });
    assert.deepEqual(listBlockPages(root), [
      { slug: 'a', title: 'Aye' },
      { slug: 'b', title: 'Bee' }
    ]);
  });

  it('lists only valid pages, skipping corrupt and malformed files', (t: TestContext) => {
    const root = withBlocks(t, {
      'a.json': 'not json{{{',
      'b.json': { version: 1, body: [{ type: 'nope' }], fields: { slug: 'bad' } },
      'c.json': { ...PAGE, fields: { slug: 'BAD SLUG' } },
      'd.json': ['not', 'a', 'page'],
      'e.json': { ...PAGE, fields: { slug: 'untitled' } },
      'notes.txt': 'ignored',
      'f.json': PAGE
    });
    assert.deepEqual(listBlockPages(root), [
      { slug: 'hello', title: 'Hello' },
      { slug: 'untitled', title: 'untitled' }
    ]);
  });

  it('lists nothing when the blocks dir is absent', (t: TestContext) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-block-pages-empty-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.deepEqual(listBlockPages(root), []);
  });

  it('reads an indexed page from its row path without resolving the slug', (t: TestContext) => {
    const root = withBlocks(t, {
      'a.json': { ...PAGE, fields: { title: 'First file', slug: 'hello' } },
      'b.json': { ...PAGE, fields: { title: 'Indexed file', slug: 'hello' } }
    });
    const direct = readIndexedBlockPage(root, { slug: 'hello', path: 'content/blocks/b.json' });
    assert.equal(direct?.title, 'Indexed file');
    assert.equal(readBlockPage(root, 'hello')?.title, 'First file');
  });

  it('falls back to the slug when the row path is stale or markdown', (t: TestContext) => {
    const root = withBlocks(t, {
      'a.json': PAGE,
      'b.json': { ...PAGE, fields: { title: 'Other', slug: 'other' } }
    });
    for (const p of ['content/blocks/b.json', 'content/blocks/gone.json', 'content/posts/a.md']) {
      assert.equal(readIndexedBlockPage(root, { slug: 'hello', path: p })?.title, 'Hello', p);
    }
  });
});

describe('system slugs', () => {
  const FOOTER = {
    version: 1,
    body: [{ type: 'grid', children: [{ type: 'text', markdown: 'Foot' }] }],
    fields: { title: 'Footer', slug: '_footer', status: 'published', kind: 'page' }
  };

  it('isEditableSlug accepts plain slugs and _footer only', () => {
    assert.equal(isEditableSlug('hello-1'), true);
    assert.equal(isEditableSlug('_footer'), true);
    assert.equal(isEditableSlug('_other'), false);
    assert.equal(isEditableSlug('_render'), false);
    assert.equal(isEditableSlug('../x'), false);
    assert.deepEqual([...SYSTEM_SLUGS], ['_footer']);
  });

  it('resolves _footer only from _footer.json', (t: TestContext) => {
    const root = withBlocks(t, { 'a-footer.json': FOOTER });
    assert.equal(readBlockPage(root, '_footer'), null);
    assert.equal(findBlockFile(root, '_footer'), null);
  });

  it('reads _footer but not other underscore slugs, and does not list it', (t: TestContext) => {
    const root = withBlocks(t, {
      '_footer.json': FOOTER,
      '_other.json': { ...FOOTER, fields: { ...FOOTER.fields, slug: '_other' } },
      'hello.json': PAGE
    });
    assert.equal(readBlockPage(root, '_footer')?.title, 'Footer');
    assert.equal(readBlockPage(root, '_other'), null);
    assert.deepEqual(
      listBlockPages(root).map((p) => p.slug),
      ['hello']
    );
  });
});
