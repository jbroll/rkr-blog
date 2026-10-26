import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { primitiveNode } from '../../src/admin/blocks-editor.ts';
import { findDropSlot } from '../../src/admin/drop-slots.ts';
import { hydrate } from '../../src/admin/unified-hydrate.ts';
import type { BlockNode, BlockTree } from '../../src/lib/blocks.ts';
import { renderBlockTree } from '../../src/lib/blocks-render.ts';
import type { ImageMap } from '../../src/lib/image-map.ts';
import { type VideoMapView, WidgetRegistry } from '../../src/lib/widgets.ts';

import { FakeDocument, type FakeElement } from './fake-dom.ts';

const ctx = {
  images: new Map() as ImageMap,
  videos: new Map() as VideoMapView,
  widgets: new WidgetRegistry()
};

async function page(body: BlockNode[]): Promise<{ tree: BlockTree; root: FakeElement }> {
  const tree: BlockTree = { version: 1, body };
  const root = new FakeDocument().createElement('div');
  root.innerHTML = await renderBlockTree(
    tree,
    ctx,
    { get: () => undefined },
    { mark: (p) => `<!--rkr:path=${p.join(',')}-->` }
  );
  hydrate(tree, root as unknown as Element);
  return { tree, root };
}

function rect(
  el: FakeElement | null | undefined,
  left: number,
  top: number,
  width: number,
  height: number
) {
  assert.ok(el);
  (el as unknown as Record<string, unknown>).getBoundingClientRect = () => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height
  });
}

const text = (markdown: string): BlockNode => ({ type: 'text', markdown });
const TEXT = primitiveNode('primitive:text');

function find(
  root: FakeElement,
  x: number,
  y: number,
  hovered: FakeElement | null | undefined,
  dragged: BlockNode,
  from: number[] | null = null
) {
  return (t: BlockTree) =>
    findDropSlot(
      root as unknown as Element,
      t,
      x,
      y,
      (hovered ?? null) as unknown as Element | null,
      dragged,
      from
    );
}

describe('findDropSlot', () => {
  it('two cells side by side: the gap between them is a vertical slot at index 1', async () => {
    const { tree, root } = await page([
      { type: 'grid', slots: { cols: 2 }, children: [text('A'), text('B')] }
    ]);
    const grid = root.querySelector('.rkr-grid');
    const [a, b] = root.querySelectorAll('.rkr-grid-cell');
    rect(a, 0, 0, 100, 100);
    rect(b, 120, 0, 100, 100);
    const slot = find(root, 110, 50, grid, TEXT)(tree);
    assert.deepEqual(slot && { ...slot, anchor: undefined }, {
      parentPath: [0],
      index: 1,
      anchor: undefined,
      side: 'after',
      axis: 'vertical'
    });
    assert.equal(slot?.anchor, a);
  });

  it('the same cells stacked (collapsed) give a horizontal slot', async () => {
    const { tree, root } = await page([
      { type: 'grid', slots: { cols: 2 }, children: [text('A'), text('B')] }
    ]);
    const grid = root.querySelector('.rkr-grid');
    const [a, b] = root.querySelectorAll('.rkr-grid-cell');
    rect(a, 0, 0, 100, 100);
    rect(b, 0, 120, 100, 100);
    const slot = find(root, 50, 110, grid, TEXT)(tree);
    assert.equal(slot?.index, 1);
    assert.equal(slot?.axis, 'horizontal');
  });

  it('a pointer anywhere in a wide gap takes that gap, not the nearer cell edge', async () => {
    const { tree, root } = await page([
      { type: 'grid', slots: { cols: 1 }, children: [text('A'), text('B')] }
    ]);
    const grid = root.querySelector('.rkr-grid');
    const [a, b] = root.querySelectorAll('.rkr-grid-cell');
    rect(a, 0, 0, 100, 100);
    rect(b, 0, 600, 100, 100);
    assert.equal(find(root, 50, 560, grid, TEXT)(tree)?.index, 1);
  });

  it('the gap below a paragraph inside a page-level grid lands after it, not at the top', async () => {
    const { tree, root } = await page([
      { type: 'grid', slots: { cols: 1 }, children: [text('Only')] }
    ]);
    const grid = root.querySelector('.rkr-grid');
    const [cell] = root.querySelectorAll('.rkr-grid-cell');
    rect(grid, 0, 0, 800, 300);
    rect(cell, 0, 0, 800, 100);
    const slot = find(root, 400, 150, grid, TEXT)(tree);
    assert.deepEqual(slot && [slot.parentPath, slot.index, slot.side, slot.axis], [
      [0],
      1,
      'after',
      'horizontal'
    ]);
  });

  it('a lone cell beside free space takes a vertical slot after it', async () => {
    const { tree, root } = await page([
      { type: 'grid', slots: { cols: 2 }, children: [text('Left')] }
    ]);
    const grid = root.querySelector('.rkr-grid');
    const [cell] = root.querySelectorAll('.rkr-grid-cell');
    rect(cell, 0, 0, 300, 100);
    const slot = find(root, 450, 50, grid, TEXT)(tree);
    assert.deepEqual(slot && [slot.index, slot.side, slot.axis], [1, 'after', 'vertical']);
  });

  it('an empty grid offers only inside, on its placeholder', async () => {
    const { tree, root } = await page([{ type: 'grid', slots: { cols: 2 }, children: [] }]);
    const placeholder = root.querySelector('[data-rkr-grid-empty]');
    const slot = find(root, 10, 10, placeholder, TEXT)(tree);
    assert.deepEqual(slot && [slot.parentPath, slot.index, slot.side], [[0], 0, 'inside']);
    assert.equal(slot?.anchor, placeholder);
  });

  it('a band section finds its inner grid from the section element', async () => {
    const { tree, root } = await page([
      { type: 'grid', slots: { cols: 1, band: true }, children: [text('A'), text('B')] }
    ]);
    const section = root.querySelector('section');
    const [a, b] = root.querySelectorAll('.rkr-grid-cell');
    rect(a, 0, 0, 100, 100);
    rect(b, 0, 200, 100, 100);
    const slot = find(root, 50, 140, section, TEXT)(tree);
    assert.deepEqual(slot && [slot.parentPath, slot.index], [[0], 1]);
  });

  it('a widths grid is measured through its wrap', async () => {
    const { tree, root } = await page([
      { type: 'grid', slots: { cols: 2, widths: '2 1' }, children: [text('A'), text('B')] }
    ]);
    const wrap = root.querySelector('.rkr-grid-wrap');
    const [a, b] = root.querySelectorAll('.rkr-grid-cell');
    rect(a, 0, 0, 200, 100);
    rect(b, 220, 0, 100, 100);
    const slot = find(root, 330, 50, wrap, TEXT)(tree);
    assert.deepEqual(slot && [slot.index, slot.axis], [2, 'vertical']);
  });

  it('a pointer over no grid targets the page body', async () => {
    const { tree, root } = await page([
      text('Top'),
      { type: 'grid', slots: { cols: 2 }, children: [text('In')] }
    ]);
    const [p] = root.querySelectorAll('p');
    rect(p, 0, 0, 800, 50);
    rect(root.querySelector('.rkr-grid'), 0, 60, 800, 100);
    const slot = find(root, 400, 200, root, TEXT)(tree);
    assert.deepEqual(slot && [slot.parentPath, slot.index, slot.side], [[], 2, 'after']);
  });

  it('a band grid is refused inside a grid and offered at page level', async () => {
    const { tree, root } = await page([
      { type: 'grid', slots: { cols: 2 }, children: [text('A')] }
    ]);
    const grid = root.querySelector('.rkr-grid');
    rect(root.querySelector('.rkr-grid-cell'), 0, 0, 100, 100);
    rect(grid, 0, 0, 800, 100);
    const section = primitiveNode('primitive:section');
    assert.equal(find(root, 50, 120, grid, section)(tree), null);
    assert.deepEqual(find(root, 50, 120, root, section)(tree)?.parentPath, []);
  });

  it('a one-column grid is refused directly inside a one-column grid', async () => {
    const { tree, root } = await page([
      { type: 'grid', slots: { cols: 1 }, children: [text('A')] }
    ]);
    const grid = root.querySelector('.rkr-grid');
    rect(root.querySelector('.rkr-grid-cell'), 0, 0, 100, 100);
    assert.equal(find(root, 50, 120, grid, primitiveNode('primitive:col'))(tree), null);
    assert.ok(find(root, 50, 120, grid, primitiveNode('primitive:row'))(tree));
  });

  it('a grid holding a grid is refused in a depth-2 grid', async () => {
    const { tree, root } = await page([
      {
        type: 'grid',
        slots: { cols: 2 },
        children: [{ type: 'grid', slots: { cols: 2 }, children: [text('Deep')] }]
      }
    ]);
    const inner = root.querySelectorAll('.rkr-grid')[1];
    const cells = root.querySelectorAll('.rkr-grid-cell');
    rect(cells[1], 0, 0, 100, 100);
    const nested: BlockNode = {
      type: 'grid',
      slots: { cols: 2 },
      children: [{ type: 'grid', slots: { cols: 2 }, children: [] }]
    };
    assert.equal(find(root, 150, 50, inner, nested)(tree), null);
    assert.deepEqual(
      find(root, 150, 50, inner, primitiveNode('primitive:row'))(tree)?.parentPath,
      [0, 0]
    );
  });

  it('dropping a block onto its own slot is refused', async () => {
    const { tree, root } = await page([text('One'), text('Two'), text('Three')]);
    const [one, two, three] = root.querySelectorAll('p');
    rect(one, 0, 0, 800, 50);
    rect(two, 0, 100, 800, 50);
    rect(three, 0, 200, 800, 50);
    const dragged = tree.body[1] as BlockNode;
    assert.equal(find(root, 400, 75, two, dragged, [1])(tree), null);
    assert.equal(find(root, 400, 175, two, dragged, [1])(tree), null);
    assert.deepEqual(find(root, 400, 260, three, dragged, [1])(tree)?.index, 3);
  });

  it('a grid cannot be dropped into itself', async () => {
    const { tree, root } = await page([
      { type: 'grid', slots: { cols: 2 }, children: [text('A'), text('B')] }
    ]);
    const grid = root.querySelector('.rkr-grid');
    const [a, b] = root.querySelectorAll('.rkr-grid-cell');
    rect(a, 0, 0, 100, 100);
    rect(b, 120, 0, 100, 100);
    assert.equal(find(root, 110, 50, grid, tree.body[0] as BlockNode, [0])(tree), null);
  });
});
