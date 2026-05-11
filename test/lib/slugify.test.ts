import assert from 'node:assert/strict';
import { test } from 'node:test';

import { slugify } from '../../src/lib/slugify.ts';

test('slugify: lowercase, kebab-cased', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('My First Post'), 'my-first-post');
});

test('slugify: collapses non-alphanumeric runs into single hyphens', () => {
  assert.equal(slugify('foo   bar---baz!!!qux'), 'foo-bar-baz-qux');
});

test('slugify: trims leading/trailing hyphens', () => {
  assert.equal(slugify('---hello---'), 'hello');
  assert.equal(slugify('!!! ouch'), 'ouch');
});

test('slugify: strips diacritics', () => {
  assert.equal(slugify('Café'), 'cafe');
  assert.equal(slugify('naïveté'), 'naivete');
  assert.equal(slugify('über schön'), 'uber-schon');
});

test('slugify: empty / all-symbol input → falls back to untitled-<stamp>', () => {
  const a = slugify('');
  assert.match(a, /^untitled-\d+$/);
  const b = slugify('!!! @@@ ###');
  assert.match(b, /^untitled-\d+$/);
});

test('slugify: caps at 100 chars and never ends on a hyphen', () => {
  const longTitle =
    'a really really really really really really really really really really really really really really really long title';
  const s = slugify(longTitle);
  assert.ok(s.length <= 100, `expected ≤100, got ${s.length}`);
  assert.ok(!s.endsWith('-'), `slug ended on a hyphen: "${s}"`);
});

test('slugify: result matches the server slug regex', () => {
  const re = /^[a-z0-9][a-z0-9-]*$/;
  for (const t of [
    'Hello World',
    'a',
    'Photos of Paris (2024)',
    'café & croissants',
    'Mixed-CASE_123 test'
  ]) {
    assert.match(slugify(t), re, `"${t}" → "${slugify(t)}" should match ${re}`);
  }
});
