import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getAtPath,
  insertAtPath,
  labelFor,
  moveNode,
  removeAtPath,
  renderCard,
  resolveDrop,
  setSlotAtPath
} from '../../src/admin/blocks-page-editor.ts';
import type { BlockTree } from '../../src/lib/blocks.ts';

const TREE: BlockTree = {
  version: 1,
  body: [
    {
      type: 'section',
      children: [
        { type: 'text', markdown: 'Hello' },
        { type: 'row', children: [{ type: 'text', markdown: 'Card' }] }
      ]
    }
  ]
};

describe('blocks page editor ops', () => {
  it('reads nodes by path', () => {
    assert.equal(getAtPath(TREE, [])?.type, undefined);
    assert.equal(getAtPath(TREE, [0])?.type, 'section');
    assert.equal(getAtPath(TREE, [0, 1, 0])?.type, 'text');
    assert.equal(getAtPath(TREE, [0, 9]), null);
  });

  it('sets a slot immutably', () => {
    const next = setSlotAtPath(TREE, [0, 1, 0], 'markdown', 'Changed');
    assert.equal(getAtPath(next, [0, 1, 0])?.type, 'text');
    assert.equal((getAtPath(next, [0, 1, 0]) as { markdown?: string }).markdown, 'Changed');
    assert.equal((getAtPath(TREE, [0, 1, 0]) as { markdown?: string }).markdown, 'Card');
  });

  it('inserts and removes nodes', () => {
    const node = { type: 'text', markdown: 'New' } as const;
    const next = insertAtPath(TREE, [0], 1, node);
    assert.equal((next.body[0] as { children: unknown[] }).children.length, 3);
    const back = removeAtPath(next, [0, 1]);
    assert.equal((back.body[0] as { children: unknown[] }).children.length, 2);
  });

  it('moves a node across containers', () => {
    const next = moveNode(TREE, [0, 1, 0], [0], 0);
    const section = next.body[0] as { children: { type: string; markdown?: string }[] };
    assert.equal(section.children[0]?.markdown, 'Card');
    assert.equal(section.children.length, 3);
  });

  it('refuses moves into their own descendants', () => {
    assert.throws(() => moveNode(TREE, [0], [0, 1], 0), /descendant/);
  });

  it('labels nodes for card headers', () => {
    assert.equal(labelFor({ type: 'section' }), 'Section');
    assert.equal(labelFor({ type: 'text', markdown: 'Hi' }), 'Text');
    assert.equal(labelFor({ type: 'macro', macro: 'hero' }), 'Macro: hero');
  });

  it('renders cards with escaped content and data paths', () => {
    const html = renderCard({ type: 'text', markdown: '<b>Hi</b>' }, [0]);
    assert.match(html, /data-path="0"/);
    assert.match(html, /&lt;b&gt;/);
  });

  it('resolves drops before and after a card to its parent', () => {
    assert.deepEqual(resolveDrop(TREE, [0, 1], 'before'), { parentPath: [0], index: 1 });
    assert.deepEqual(resolveDrop(TREE, [0, 1], 'after'), { parentPath: [0], index: 2 });
    assert.deepEqual(resolveDrop(TREE, [0], 'before'), { parentPath: [], index: 0 });
  });

  it('resolves inside drops to container ends, never into leaves or macros', () => {
    assert.deepEqual(resolveDrop(TREE, [0, 1], 'inside'), { parentPath: [0, 1], index: 1 });
    assert.equal(resolveDrop(TREE, [0, 0], 'inside'), null);
    assert.deepEqual(resolveDrop(TREE, [0], 'inside'), { parentPath: [0], index: 2 });
    assert.equal(
      resolveDrop({ ...TREE, body: [{ type: 'macro', macro: 'hero' }] }, [0], 'inside'),
      null
    );
  });
});
