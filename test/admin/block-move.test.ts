import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isInside, moveBlock, movedPath } from '../../src/admin/block-move.ts';
import type { BlockTree } from '../../src/lib/blocks.ts';

const tree: BlockTree = {
  version: 1,
  body: [
    { type: 'text', markdown: 'T' },
    { type: 'grid', slots: { cols: 2 }, children: [{ type: 'text', markdown: 'R' }] },
    { type: 'text', markdown: 'U' }
  ]
};

describe('moveBlock', () => {
  it('moves into a later container whose index shifts down', () => {
    const next = moveBlock(tree, [0], [1], 1);
    assert.deepEqual(
      next.body.map((n) => n.type),
      ['grid', 'text']
    );
    assert.equal((next.body[0] as { children: unknown[] }).children.length, 2);
    assert.deepEqual(movedPath([0], [1], 1), [0, 1]);
  });

  it('adjusts the index within the same list', () => {
    assert.deepEqual(movedPath([0], [], 2), [1]);
    assert.deepEqual(movedPath([2], [], 0), [0]);
    const next = moveBlock(tree, [0], [], 3);
    assert.deepEqual(
      next.body.map((n) => (n as { markdown?: string }).markdown ?? n.type),
      ['grid', 'U', 'T']
    );
  });

  it('moves out of a container', () => {
    const next = moveBlock(tree, [1, 0], [], 0);
    assert.equal((next.body[0] as { markdown?: string }).markdown, 'R');
    assert.equal((next.body[2] as { children: unknown[] }).children.length, 0);
  });

  it('refuses a move into its own descendant', () => {
    assert.ok(isInside([1], [1, 0]));
    assert.ok(!isInside([1], [2]));
    assert.throws(() => moveBlock(tree, [1], [1], 0), /descendant/);
    assert.throws(() => moveBlock(tree, [9], [], 0), /not found/);
  });
});
