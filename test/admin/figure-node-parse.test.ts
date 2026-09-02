// String attributes must parse back from rendered HTML as strings.
// Tiptap's default attribute parser coerces numeric-looking values to
// numbers, which breaks a caption of "2024" or an all-digit id prefix
// on paste. Pure (no DOM): each attribute's parseHTML is fed an element
// stub. The video node's equivalent is covered in video-upload.spec.ts;
// importing it here would pull it into the unit coverage universe and
// reset its ratchet denominator.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FigureNode } from '../../src/admin/figure-node.ts';

type AttrSpec = { default: unknown; parseHTML?: (el: Element) => unknown };

function attrsOf(node: { config: { addAttributes?: unknown } }): Record<string, AttrSpec> {
  return (node.config.addAttributes as () => Record<string, AttrSpec>)();
}

function elementWith(attrs: Record<string, string>): Element {
  return { getAttribute: (k: string) => attrs[k] ?? null } as unknown as Element;
}

function parseAll(specs: Record<string, AttrSpec>, el: Element): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(specs).map(([k, s]) => [k, s.parseHTML ? s.parseHTML(el) : s.default])
  );
}

test('figure attributes parse back as strings, timer as a number', () => {
  const attrs = {
    ids: '123456,bbb',
    alts: 'one\\, two,three',
    captions: '2024|c2',
    caption: '2024',
    matrix: '1x2',
    justify: 'left',
    width: '60%',
    aspect: '16:9',
    fit: 'contain',
    timer: '5'
  };
  const got = parseAll(attrsOf(FigureNode), elementWith(attrs));
  assert.deepEqual(got, { ...attrs, timer: 5 });
});

test('figure attributes fall back to defaults when missing', () => {
  const got = parseAll(attrsOf(FigureNode), elementWith({ ids: 'aaa' }));
  assert.equal(got.ids, 'aaa');
  assert.equal(got.justify, 'center');
  assert.equal(got.fit, 'cover');
  assert.equal(got.timer, 0);
  assert.equal(got.alts, '');
});
