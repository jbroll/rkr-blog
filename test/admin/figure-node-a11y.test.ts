// FigureNode.renderHTML must emit reorder a11y hooks: each thumb is a
// focusable button with a positional aria-label. The aria-live status
// region is deliberately NOT in renderHTML (ProseMirror regenerates
// this node every transaction, which would wipe the announcement) —
// figure-reorder.ts owns a single live region on <body> instead, so
// renderHTML must NOT emit one. Pure (no DOM) — calls renderHTML.

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

test('renderHTML does NOT emit an aria-live status node (owned by figure-reorder.ts on <body>)', () => {
  const s = render('a,b');
  assert.doesNotMatch(s, /aria-live/);
  assert.doesNotMatch(s, /data-reorder-status/);
});
