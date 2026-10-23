import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { extractBlockTeaser } from '../../src/lib/block-teaser.ts';
import type { BlockTree } from '../../src/lib/blocks.ts';
import { WidgetRegistry } from '../../src/lib/widgets.ts';
import figureWidget from '../../src/widgets/figure.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-block-teaser-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function registry(): WidgetRegistry {
  const widgets = new WidgetRegistry();
  widgets.register(figureWidget);
  return widgets;
}

test('extractBlockTeaser: no figure in the tree → null', async (t) => {
  const root = freshSiteRoot(t);
  const tree: BlockTree = {
    version: 1,
    body: [{ type: 'text', markdown: 'Just prose, no hero.' }]
  };
  assert.equal(await extractBlockTeaser(root, tree, registry(), 30), null);
});

test('extractBlockTeaser: skips macros and non-text leaves, reads slots.markdown', async (t) => {
  const root = freshSiteRoot(t);
  const tree: BlockTree = {
    version: 1,
    body: [
      {
        type: 'section',
        children: [
          { type: 'macro', macro: 'hidden-hero' },
          { type: 'figure', slots: { ids: ['aaaa1111', 'bbbb2222'], justify: null } },
          { type: 'video', slots: { ids: 'cccc3333' } },
          { type: 'text', slots: { markdown: 'Lede from slots.' } }
        ]
      }
    ]
  };
  const parts = await extractBlockTeaser(root, tree, registry(), 30);
  assert.ok(parts);
  assert.match(parts.excerptHtml, /Lede from slots\./);
});

test('extractBlockTeaser: a lede with no paragraph → null', async (t) => {
  const root = freshSiteRoot(t);
  const tree: BlockTree = {
    version: 1,
    body: [
      { type: 'figure', slots: { ids: 'aaaa1111' } },
      { type: 'text', markdown: '::figure{ids="bbbb2222"}' }
    ]
  };
  assert.equal(await extractBlockTeaser(root, tree, registry(), 30), null);
});
