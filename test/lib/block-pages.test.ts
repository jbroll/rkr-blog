import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { readBlockPage } from '../../src/lib/block-pages.ts';

const PAGE = {
  version: 1,
  body: [{ type: 'flow', blocks: [{ type: 'text', markdown: 'Hello world.' }] }],
  fields: { title: 'Hello', slug: 'hello' },
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
    assert.equal(page.tree.body[0]?.type, 'flow');
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
      'c.json': PAGE,
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
});
