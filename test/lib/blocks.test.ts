import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type BlockNode,
  type ContainerKind,
  type ContainerNode,
  containerDepth,
  detectCycle,
  type LeafNode,
  type MacroInstanceNode,
  parseBlockTree,
  resolveSlots
} from '../../src/lib/blocks.ts';

describe('blocks', () => {
  it('unset follows default, empty string stays local', () => {
    const out = resolveSlots({ defaults: { title: 'Brand' } }, {});
    assert.equal(out.slots.title, 'Brand');
    const overridden = resolveSlots({ defaults: { title: 'Brand' } }, { title: '' });
    assert.equal(overridden.slots.title, '');
    const set = resolveSlots({ defaults: { title: 'Brand' } }, { title: 'Local' });
    assert.equal(set.slots.title, 'Local');
  });

  it('detects self cycle', () => {
    assert.ok(detectCycle({ hero: ['hero'] }, 'hero'));
    assert.equal(detectCycle({ a: ['b'], b: [] }, 'a'), null);
  });

  it('detects transitive cycle', () => {
    assert.ok(detectCycle({ a: ['b'], b: ['a'] }, 'a'));
  });

  it('measures section>row>col>leaf as depth 3', () => {
    assert.equal(
      containerDepth({
        type: 'section',
        children: [
          {
            type: 'row',
            children: [{ type: 'col', children: [{ type: 'text', markdown: 'hi' }] }]
          }
        ]
      }),
      3
    );
  });

  it('parseBlockTree rejects unknown node types', () => {
    assert.throws(
      () => parseBlockTree({ version: 1, body: [{ type: 'nope' }] }),
      /unknown block type/
    );
  });

  it('parseBlockTree accepts a flow page body', () => {
    const tree = parseBlockTree({
      version: 1,
      body: [{ type: 'flow', blocks: [{ type: 'text', markdown: 'Hello' }] }]
    });
    assert.equal(tree.body[0]?.type, 'flow');
  });

  it('exposes container, leaf, and macro node types', () => {
    const kinds: ContainerKind[] = ['section', 'row', 'col', 'flow'];
    assert.equal(kinds.length, 4);
    const leaf: LeafNode = { type: 'text', markdown: 'x' };
    const section: ContainerNode = { type: 'section', children: [leaf] };
    const inst: MacroInstanceNode = { type: 'macro', macro: 'hero' };
    const nodes: BlockNode[] = [leaf, section, inst];
    assert.equal(nodes.length, 3);
  });
});
