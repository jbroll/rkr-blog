import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveIds } from '../../src/lib/id-resolve.ts';

const A = 'a'.repeat(64);
const B = `${'a'.repeat(6)}${'b'.repeat(58)}`;
const C = `c${'0'.repeat(63)}`;

test('resolveIds keeps a full id present in the known set', () => {
  assert.deepEqual(resolveIds([A], [A, C]), [A]);
});

test('resolveIds drops a full id absent from the known set', () => {
  assert.deepEqual(resolveIds([A], [C]), [null]);
});

test('resolveIds resolves a prefix matching exactly one known id', () => {
  assert.deepEqual(resolveIds(['c00000'], [A, C]), [C]);
});

test('resolveIds drops a prefix matching more than one known id', () => {
  assert.deepEqual(resolveIds(['aaaaaa'], [A, B]), [null]);
});

test('resolveIds drops a prefix matching nothing', () => {
  assert.deepEqual(resolveIds(['ffffff'], [A, C]), [null]);
});

test('resolveIds handles the 6-char and 63-char boundaries', () => {
  assert.deepEqual(resolveIds([A.slice(0, 6), A.slice(0, 63)], [A]), [A, A]);
});

test('resolveIds returns one entry per input, in order', () => {
  assert.deepEqual(resolveIds(['c00000', 'ffffff', A], [A, C]), [C, null, A]);
});
