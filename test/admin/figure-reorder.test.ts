// Pure permute helpers for figure image reorder. DOM wiring
// (wireFigureReorder) is exercised by test/e2e/figure-reorder.spec.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { moveItem, reorderFigureCells } from '../../src/admin/figure-reorder.ts';

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
