import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  childrenOf,
  getAtPath,
  insertAtPath,
  removeAtPath,
  setSlotAtPath,
  unwrapAtPath,
  updateSlotsAtPath,
  wrapAtPath
} from '../../src/admin/block-tree-ops.ts';
import type { BlockTree, Slots } from '../../src/lib/blocks.ts';

const TREE: BlockTree = {
  version: 1,
  body: [
    {
      type: 'grid',
      children: [
        { type: 'text', markdown: 'Hello' },
        { type: 'grid', children: [{ type: 'text', markdown: 'Card' }] }
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
    assert.equal(getAtPath(TREE, [0])?.type, 'grid');
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

  it('inserts into an empty grid and removes its last child', () => {
    const tree: BlockTree = {
      version: 1,
      body: [{ type: 'grid', slots: { cols: 2 }, children: [] }]
    };
    const next = insertAtPath(tree, [0], 5, { type: 'text', markdown: 'In' });
    assert.deepEqual(
      childrenOf(next.body[0] as never).map((n) => n.type),
      ['text']
    );
    assert.deepEqual(childrenOf(removeAtPath(next, [0, 0]).body[0] as never), []);
  });

  it('refuses a leaf as a parent', () => {
    assert.throws(() => insertAtPath(TREE, [0, 0], 0, { type: 'text' }), /bad parent/);
    assert.deepEqual(childrenOf({ type: 'text' }), []);
    assert.deepEqual(childrenOf({ type: 'macro', macro: 'hero' }), []);
  });

  it('wraps a block in a grid and unwraps it back', () => {
    const tree: BlockTree = { version: 1, body: [{ type: 'text', markdown: 'A' }] };
    const wrapped = wrapAtPath(tree, [0], 2);
    assert.deepEqual(wrapped.body[0], {
      type: 'grid',
      slots: { cols: 2 },
      children: [{ type: 'text', markdown: 'A' }]
    });
    assert.deepEqual(unwrapAtPath(wrapped, [0]), tree);
  });

  it('unwrap lifts every child into the parent at the grid index', () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        {
          type: 'grid',
          children: [
            { type: 'text', markdown: 'a' },
            {
              type: 'grid',
              slots: { cols: 2 },
              children: [
                { type: 'text', markdown: 'b' },
                { type: 'text', markdown: 'c' }
              ]
            },
            { type: 'text', markdown: 'd' }
          ]
        }
      ]
    };
    const next = unwrapAtPath(tree, [0, 1]);
    assert.deepEqual(
      childrenOf(next.body[0] as never).map((n) => (n as { markdown: string }).markdown),
      ['a', 'b', 'c', 'd']
    );
  });

  it('unwrap of an empty grid removes it', () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'text', markdown: 'a' },
        { type: 'grid', children: [] }
      ]
    };
    assert.deepEqual(unwrapAtPath(tree, [1]).body, [{ type: 'text', markdown: 'a' }]);
  });

  it('unwrap refuses a leaf', () => {
    assert.throws(() => unwrapAtPath({ version: 1, body: [{ type: 'text' }] }, [0]), /not a grid/);
  });
});
