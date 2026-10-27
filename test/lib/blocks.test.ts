import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  type BlockNode,
  type ContainerNode,
  containerDepth,
  detectCycle,
  type FieldSpec,
  type LeafNode,
  type MacroInstanceNode,
  parseBlockTree,
  resolveSlots,
  validateForSave
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

  it('measures nested grids as depth 3', () => {
    assert.equal(
      containerDepth({
        type: 'grid',
        children: [
          {
            type: 'grid',
            children: [{ type: 'grid', children: [{ type: 'text', markdown: 'hi' }] }]
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

  it('parseBlockTree expands a flow page body to a grid', () => {
    const tree = parseBlockTree({
      version: 1,
      body: [{ type: 'flow', blocks: [{ type: 'text', markdown: 'Hello' }] }]
    });
    assert.equal(tree.body[0]?.type, 'grid');
    assert.equal((tree.body[0] as ContainerNode).children.length, 1);
  });

  it('exposes container, leaf, and macro node types', () => {
    const leaf: LeafNode = { type: 'text', markdown: 'x' };
    const section: ContainerNode = { type: 'grid', children: [leaf] };
    const inst: MacroInstanceNode = { type: 'macro', macro: 'hero' };
    const nodes: BlockNode[] = [leaf, section, inst];
    assert.equal(nodes.length, 3);
  });

  it('parses every fixture macro tree into grid containers only', () => {
    const dir = 'test/fixtures/blocks';
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length > 0);
    const types = (n: BlockNode, out: string[] = []): string[] => {
      out.push(n.type);
      if (n.type === 'grid') for (const k of n.children) types(k, out);
      return out;
    };
    for (const f of files) {
      const raw = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { tree: unknown };
      const tree = parseBlockTree({ version: 1, body: [raw.tree] });
      const containers = tree.body
        .flatMap((n) => types(n))
        .filter((t) => ['section', 'row', 'col', 'flow', 'grid'].includes(t));
      assert.ok(containers.length > 0, f);
      assert.ok(
        containers.every((t) => t === 'grid'),
        f
      );
    }
  });

  it('keeps out-of-range grid slots as given', () => {
    const tree = parseBlockTree({ version: 1, body: [{ type: 'grid', slots: { cols: 'x' } }] });
    const grid = tree.body[0] as ContainerNode;
    assert.equal(grid.slots?.cols, 'x');
    assert.deepEqual(grid.children, []);
  });
});

describe('validateForSave', () => {
  const names = new Set(['hero']);
  const ok = (body: unknown[]) => validateForSave(parseBlockTree({ version: 1, body }), names);

  it('accepts a valid tree', () => {
    assert.equal(
      ok([
        {
          type: 'grid',
          slots: { cols: 2 },
          children: [
            { type: 'figure', slots: { ids: 'abc' } },
            { type: 'macro', macro: 'hero' }
          ]
        }
      ]),
      null
    );
  });

  it('names an unknown macro and its path', () => {
    const found = ok([
      { type: 'text', markdown: 'x' },
      { type: 'grid', children: [{ type: 'macro', macro: 'gone' }] }
    ]);
    assert.deepEqual(found, {
      path: [1, 0],
      message: "This block can't be saved: the macro gone no longer exists. Delete it to save."
    });
  });

  it('rejects an empty figure and a video without ids', () => {
    assert.deepEqual(ok([{ type: 'figure', slots: { ids: '' } }]), {
      path: [0],
      message: 'An image block has no images.'
    });
    assert.deepEqual(ok([{ type: 'video' }]), {
      path: [0],
      message: 'A video block has no video.'
    });
  });

  it('rejects a fourth grid level', () => {
    const deep = {
      type: 'grid',
      children: [{ type: 'grid', children: [{ type: 'grid', children: [{ type: 'grid' }] }] }]
    };
    assert.deepEqual(ok([deep]), { path: [0, 0, 0, 0], message: 'Grids nest at most 3 levels.' });
    assert.equal(
      ok([{ type: 'grid', children: [{ type: 'grid', children: [{ type: 'grid' }] }] }]),
      null
    );
  });

  describe('list slots', () => {
    const schemas: Record<string, Record<string, FieldSpec>> = {
      board: {
        title: { label: 'Title', type: 'text' },
        people: {
          label: 'Board members',
          type: 'list',
          item: { name: { label: 'Name', type: 'text' }, photo: { label: 'Photo', type: 'image' } }
        }
      }
    };
    const check = (slots: Record<string, unknown>) =>
      validateForSave(
        parseBlockTree({
          version: 1,
          body: [{ type: 'grid', children: [{ type: 'macro', macro: 'board', slots }] }]
        }),
        new Set(['board']),
        (m) => schemas[m]
      );

    it('accepts an array of records with known keys, or no value', () => {
      assert.equal(check({ people: [{ name: 'Ann' }, { name: 'Bo', photo: 'aa11' }] }), null);
      assert.equal(check({ people: [] }), null);
      assert.equal(check({ title: 'x' }), null);
    });

    it('validateForSave refuses a list value that is not an array of records', () => {
      for (const people of ['Ann', [{ name: 'Ann' }, 'Bo'], [[]], { name: 'Ann' }]) {
        const problem = check({ people });
        assert.deepEqual(problem?.path, [0, 0]);
        assert.match(problem?.message ?? '', /Board members/);
      }
    });

    it('validateForSave refuses an unknown key in a list item, naming the item number', () => {
      const problem = check({ people: [{ name: 'Ann' }, { name: 'Bo', age: 3 }] });
      assert.deepEqual(problem?.path, [0, 0]);
      assert.match(problem?.message ?? '', /item 2/i);
      assert.match(problem?.message ?? '', /age/);
      assert.match(check({ people: [{ constructor: 'x' }] })?.message ?? '', /item 1/);
    });

    it('skips list checks without a schema lookup', () => {
      const tree = parseBlockTree({
        version: 1,
        body: [{ type: 'macro', macro: 'board', slots: { people: 'Ann' } }]
      });
      assert.equal(validateForSave(tree, new Set(['board'])), null);
      assert.equal(
        validateForSave(tree, new Set(['board']), () => undefined),
        null
      );
    });
  });

  it('reports a bad grid slot', () => {
    const found = ok([{ type: 'grid', slots: { cols: 7 } }]);
    assert.deepEqual(found?.path, [0]);
    assert.match(found?.message ?? '', /Columns/);
  });
});
