// Pure permute helpers for figure image reorder. DOM wiring
// (wireFigureReorder) is exercised by test/e2e/figure-reorder.spec.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type CellRect,
  dropIndexFor2D,
  moveItem,
  reorderFigureCells
} from '../../src/admin/figure-reorder.ts';

test('moveItem: moves an element and returns a new array', () => {
  const a = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveItem(a, 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(a, 3, 1), ['a', 'd', 'b', 'c']);
  assert.deepEqual(a, ['a', 'b', 'c', 'd']); // input untouched
});

test('moveItem: no-op cases return an equal array', () => {
  assert.deepEqual(moveItem(['a', 'b'], 1, 1), ['a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], -1, 0), ['a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 0, 5), ['a', 'b']);
  assert.deepEqual(moveItem(['a'], 0, 0), ['a']);
});

test('reorderFigureCells: permutes ids/alts/captions in lockstep', () => {
  const out = reorderFigureCells({ ids: 'i1,i2,i3', alts: 'a1,a2,a3', captions: 'c1|c2|c3' }, 0, 2);
  assert.deepEqual(out, { ids: 'i2,i3,i1', alts: 'a2,a3,a1', captions: 'c2|c3|c1' });
});

test('reorderFigureCells: pads short alts/captions to ids length before moving', () => {
  const out = reorderFigureCells({ ids: 'i1,i2,i3', alts: 'a1', captions: 'c1' }, 2, 0);
  assert.deepEqual(out, { ids: 'i3,i1,i2', alts: ',a1,', captions: '|c1|' });
});

test('reorderFigureCells: trims ids/alts on split (captions kept verbatim)', () => {
  const out = reorderFigureCells({ ids: 'i1, i2', alts: ' a1 , a2 ', captions: 'c 1|c 2' }, 0, 1);
  assert.deepEqual(out, { ids: 'i2,i1', alts: 'a2,a1', captions: 'c 2|c 1' });
});

test('reorderFigureCells: no-op returns the original strings', () => {
  const input = { ids: 'i1,i2', alts: 'a1,a2', captions: 'c1|c2' };
  assert.deepEqual(reorderFigureCells(input, 1, 1), input);
  assert.deepEqual(reorderFigureCells(input, 0, 9), input);
});

// Single row of 3 cells, 100 wide / 80 tall, at x = 0,100,200 (y=0).
const ROW: CellRect[] = [
  { left: 0, top: 0, width: 100, height: 80 },
  { left: 100, top: 0, width: 100, height: 80 },
  { left: 200, top: 0, width: 100, height: 80 }
];
// 2×2 grid wrapping onto a second row: 0,1 on row 1 (y=0); 2,3 on
// row 2 (y=80). This is the case the old 1-D scan got wrong.
const GRID: CellRect[] = [
  { left: 0, top: 0, width: 100, height: 80 },
  { left: 100, top: 0, width: 100, height: 80 },
  { left: 0, top: 80, width: 100, height: 80 },
  { left: 100, top: 80, width: 100, height: 80 }
];

test('dropIndexFor2D: single row — before/between/after by x', () => {
  assert.equal(dropIndexFor2D(ROW, -20, 40), 0); // left of all
  assert.equal(dropIndexFor2D(ROW, 30, 40), 0); // left half of cell 0
  assert.equal(dropIndexFor2D(ROW, 70, 40), 1); // right half of cell 0
  assert.equal(dropIndexFor2D(ROW, 270, 40), 3); // right of all
});

test('dropIndexFor2D: wrapped grid — second-row pointer maps past row 1', () => {
  // Pointer over the left half of the row-2 first cell (index 2):
  // must insert at 2, NOT collapse to a first-row index.
  assert.equal(dropIndexFor2D(GRID, 30, 120), 2);
  // Right half of the last cell (row 2) → after everything.
  assert.equal(dropIndexFor2D(GRID, 170, 120), 4);
  // Row 1, right half of cell 1 → between 1 and 2.
  assert.equal(dropIndexFor2D(GRID, 170, 40), 2);
});

test('dropIndexFor2D: empty list → 0', () => {
  assert.equal(dropIndexFor2D([], 123, 45), 0);
});
