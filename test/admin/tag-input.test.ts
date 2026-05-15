// Unit tests for the pure functions in src/admin/tag-input.ts.
// DOM-coupled createTagInput is covered by /* c8 ignore */ annotations.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deduplicateTags, parseTagInput } from '../../src/admin/tag-input.ts';

test('parseTagInput: splits on commas, trims whitespace', () => {
  assert.deepEqual(parseTagInput('travel, food , tech'), ['travel', 'food', 'tech']);
});

test('parseTagInput: drops blank entries', () => {
  assert.deepEqual(parseTagInput('travel,,food'), ['travel', 'food']);
});

test('parseTagInput: drops entries over MAX_TAG_LEN', () => {
  const long = 'x'.repeat(33);
  assert.deepEqual(parseTagInput(`travel, ${long}, food`), ['travel', 'food']);
});

test('parseTagInput: single entry, no commas', () => {
  assert.deepEqual(parseTagInput('travel'), ['travel']);
});

test('parseTagInput: empty string returns empty array', () => {
  assert.deepEqual(parseTagInput(''), []);
});

test('deduplicateTags: keeps first occurrence case-insensitively', () => {
  assert.deepEqual(deduplicateTags(['Travel', 'travel', 'TRAVEL', 'food']), ['Travel', 'food']);
});

test('deduplicateTags: preserves order', () => {
  assert.deepEqual(deduplicateTags(['beta', 'alpha', 'beta']), ['beta', 'alpha']);
});

test('deduplicateTags: no duplicates → same array content', () => {
  assert.deepEqual(deduplicateTags(['a', 'b', 'c']), ['a', 'b', 'c']);
});

test('deduplicateTags: empty input → empty output', () => {
  assert.deepEqual(deduplicateTags([]), []);
});
