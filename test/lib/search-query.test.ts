import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFtsMatch } from '../../src/lib/search-query.ts';

test('words are AND-ed and the last token is prefix-matched', () => {
  assert.equal(buildFtsMatch('rust async'), 'rust async*');
});

test('single word is prefix-matched', () => {
  assert.equal(buildFtsMatch('rust'), 'rust*');
});

test('FTS5 operator characters are stripped', () => {
  assert.equal(buildFtsMatch('foo* OR -bar "baz"'), 'foo OR bar baz*');
});

test('empty / whitespace / punctuation-only returns null', () => {
  assert.equal(buildFtsMatch(''), null);
  assert.equal(buildFtsMatch('   '), null);
  assert.equal(buildFtsMatch('* - " ( )'), null);
});

test('over-long input is capped at 200 chars before tokenizing', () => {
  const long = `${'a'.repeat(300)} tail`;
  const out = buildFtsMatch(long);
  assert.ok(out && out.length <= 202 && out.endsWith('*'));
  assert.ok(out && !out.includes('tail'));
});
