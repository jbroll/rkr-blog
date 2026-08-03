import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectFigureIds, idCount, singleId } from '../../src/lib/figure-ids.ts';

test('idCount: empty / undefined → 0', () => {
  assert.equal(idCount(undefined), 0);
  assert.equal(idCount(''), 0);
  assert.equal(idCount('   '), 0);
  assert.equal(idCount(','), 0);
  assert.equal(idCount(' , , , '), 0);
});

test('idCount: single id', () => {
  assert.equal(idCount('abc'), 1);
  assert.equal(idCount('  abc  '), 1);
});

test('idCount: multiple ids', () => {
  assert.equal(idCount('a,b,c'), 3);
  assert.equal(idCount('a, b, c'), 3);
  assert.equal(idCount(' a , b , c '), 3);
});

test('idCount: trailing/leading commas dropped', () => {
  assert.equal(idCount(',a,b,'), 2);
  assert.equal(idCount('a,,b'), 2);
});

test('singleId: empty / undefined → empty string', () => {
  assert.equal(singleId(undefined), '');
  assert.equal(singleId(''), '');
});

test('singleId: returns first id, trimmed', () => {
  assert.equal(singleId('abc'), 'abc');
  assert.equal(singleId('  abc  '), 'abc');
  assert.equal(singleId('abc,def'), 'abc');
  assert.equal(singleId(' abc , def '), 'abc');
});

test('singleId: leading comma → empty first segment is returned trimmed', () => {
  // Documents the gate-on-idCount=1 contract: caller is expected to
  // verify the count first; singleId is permissive about edge inputs.
  assert.equal(singleId(',abc'), '');
});

test('collectFigureIds: figure directives at any depth, in order, deduplicated', () => {
  const figure = (ids: string) => ({
    type: 'leafDirective',
    name: 'figure',
    attributes: { ids },
    children: []
  });
  const tree = {
    type: 'root',
    children: [
      figure('AAAAAA, bbbbbb'),
      { type: 'code', value: 'color: #cccccc;' },
      {
        type: 'blockquote',
        children: [
          { type: 'paragraph', children: [{ type: 'text', value: 'dddddd' }, figure('bbbbbb')] }
        ]
      },
      { type: 'leafDirective', name: 'note', attributes: { ids: 'eeeeee' }, children: [] },
      { type: 'leafDirective', name: 'figure', children: [] }
    ]
  };
  assert.deepEqual(collectFigureIds(tree).sort(), ['aaaaaa', 'bbbbbb']);
});

test('collectFigureIds: accepts a node array and a bare node', () => {
  const node = { type: 'leafDirective', name: 'figure', attributes: { ids: 'abcdef' } };
  assert.deepEqual(collectFigureIds(node), ['abcdef']);
  assert.deepEqual(collectFigureIds([node]), ['abcdef']);
  assert.deepEqual(collectFigureIds([]), []);
});
