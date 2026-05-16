// FigureNode.renderHTML must emit reorder a11y hooks: each thumb is a
// focusable button with a positional aria-label, plus a polite
// aria-live status node. Pure (no DOM) — calls renderHTML directly.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FigureNode } from '../../src/admin/figure-node.ts';

function render(ids: string): string {
  const fn = FigureNode.config.renderHTML as (p: { HTMLAttributes: unknown }) => unknown;
  const out = fn({
    HTMLAttributes: { ids, alts: '', captions: '', caption: '', matrix: '' }
  });
  return JSON.stringify(out);
}

test('thumbs are focusable buttons with positional aria-labels', () => {
  const s = render('a,b,c');
  assert.match(s, /"tabindex":"0"/);
  assert.match(s, /"role":"button"/);
  assert.match(s, /Image 1 of 3/);
  assert.match(s, /Image 3 of 3/);
});

test('a reorder aria-live status node is present', () => {
  const s = render('a,b');
  assert.match(s, /"aria-live":"polite"/);
  assert.match(s, /data-reorder-status/);
});
