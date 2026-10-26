import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getAtPath,
  insertAtPath,
  removeAtPath,
  resolveDrop,
  setSlotAtPath,
  updateSlotsAtPath
} from '../../src/admin/block-tree-ops.ts';
import type { BlockTree, Slots } from '../../src/lib/blocks.ts';

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

describe('block tree ops', () => {
  it('updates slots with merge and delete semantics', () => {
    const tree: BlockTree = {
      version: 1,
      body: [{ type: 'macro', macro: 'hero', slots: { heading: 'Old', sub: 'Keep' } }]
    };
    const next = updateSlotsAtPath(tree, [0], (slots) => {
      const out: Slots = { ...slots, heading: 'New' };
      delete out.sub;
      return out;
    });
    assert.deepEqual((next.body[0] as { slots: unknown }).slots, { heading: 'New' });
    assert.deepEqual((tree.body[0] as { slots: unknown }).slots, { heading: 'Old', sub: 'Keep' });
  });

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
