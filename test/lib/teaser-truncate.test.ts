import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Paragraph } from 'mdast';
import { truncateParagraph } from '../../src/lib/teaser-truncate.ts';

const para = (...children: unknown[]) => ({ type: 'paragraph', children }) as Paragraph;
const text = (value: string) => ({ type: 'text', value });
const emph = (...children: unknown[]) => ({ type: 'emphasis', children });

test('maxWords <= 0 returns the input untouched (same reference)', () => {
  const p = para(text('one two three four'));
  assert.equal(truncateParagraph(p, 0), p);
  assert.equal(truncateParagraph(p, -5), p);
});

test('within the limit returns the input untouched (same reference)', () => {
  const p = para(text('one two three'));
  assert.equal(truncateParagraph(p, 3), p);
  assert.equal(truncateParagraph(p, 10), p);
});

test('over the limit: plain text trimmed to N words + ellipsis', () => {
  const out = truncateParagraph(para(text('one two three four five')), 3);
  assert.notEqual(out.children, undefined);
  assert.deepEqual(
    out.children.map((c) => (c as { value: string }).value),
    ['one two three', '…']
  );
});

test('inline markup is preserved across the cut, ellipsis at top level', () => {
  const p = para(text('alpha beta '), emph(text('gamma delta')), text(' epsilon'));
  const out = truncateParagraph(p, 3);
  assert.equal(out.children.length, 3);
  assert.equal((out.children[0] as { value: string }).value, 'alpha beta ');
  const e = out.children[1] as { type: string; children: { value: string }[] };
  assert.equal(e.type, 'emphasis');
  assert.equal(e.children[0]?.value, 'gamma');
  assert.equal((out.children[2] as { value: string }).value, '…');
});

test('an emphasis fully within budget is kept whole, no ellipsis', () => {
  const p = para(text('a b'), emph(text('c d')));
  assert.equal(truncateParagraph(p, 4), p);
});

test('inlineCode words are counted', () => {
  const p = para(text('one '), { type: 'inlineCode', value: 'two three' }, text(' four'));
  const out = truncateParagraph(p, 2);
  // 'one' (1) + inlineCode 'two three' (2) exceeds 2 → code dropped, ellipsis added
  assert.equal((out.children.at(-1) as { value: string }).value, '…');
  assert.ok(out.children.every((c) => (c as { type: string }).type !== 'inlineCode'));
});
