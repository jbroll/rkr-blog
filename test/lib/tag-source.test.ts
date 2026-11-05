import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BlockTree, Slots } from '../../src/lib/blocks.ts';
import { type RenderMacroLib, renderBlockTree } from '../../src/lib/blocks-render.ts';
import type { ImageMap } from '../../src/lib/image-map.ts';
import {
  isTagSource,
  resolveTagSources,
  type TagLookup,
  tagSourceProblem
} from '../../src/lib/tag-source.ts';
import type { VideoMapView } from '../../src/lib/widgets.ts';
import { WidgetRegistry } from '../../src/lib/widgets.ts';

const macroTree = (slots: Slots): BlockTree => ({
  version: 1,
  body: [
    { type: 'grid', children: [{ type: 'macro', macro: 'cards', slots }] },
    { type: 'macro', macro: 'cards', slots: { cards: [{ title: 'kept' }] } }
  ]
});

const slotsAt = (tree: BlockTree, i: number): Slots | undefined => {
  const n = tree.body[i];
  if (n?.type === 'grid') return (n.children[0] as { slots?: Slots }).slots;
  return (n as { slots?: Slots }).slots;
};

describe('tag source', () => {
  it('isTagSource wants a non-array object with a string tag', () => {
    assert.equal(isTagSource({ tag: 'x' }), true);
    assert.equal(isTagSource([]), false);
    assert.equal(isTagSource('x'), false);
    assert.equal(isTagSource({ tag: 1 }), false);
  });

  it('tagSourceProblem names each bad field', () => {
    assert.equal(tagSourceProblem('L', { tag: 'x', sort: 'date', limit: 3 }), null);
    assert.equal(tagSourceProblem('L', { tag: '' }), 'L: tag must be a non-empty string.');
    assert.equal(
      tagSourceProblem('L', { tag: 'x', sort: 'title' }),
      'L: sort must be order or date.'
    );
    assert.equal(
      tagSourceProblem('L', { tag: 'x', limit: 0 }),
      'L: limit must be a positive whole number.'
    );
    assert.equal(
      tagSourceProblem('L', { tag: 'x', limit: 1.5 }),
      'L: limit must be a positive whole number.'
    );
    assert.equal(tagSourceProblem('L', { tag: 'x', foo: 1 }), 'L: unknown key foo.');
  });

  it('resolveTagSources fills a page instance slot and leaves an array slot alone', () => {
    const rows = [{ title: 'A' }];
    const out = resolveTagSources(macroTree({ cards: { tag: 'b' } }), () => rows);
    assert.deepEqual(slotsAt(out, 0), { cards: rows });
    assert.deepEqual(slotsAt(out, 1), { cards: [{ title: 'kept' }] });
  });

  it('passes the source and selfSlug to the lookup', () => {
    const seen: unknown[] = [];
    const lookup: TagLookup = (src, self) => {
      seen.push(src, self);
      return [];
    };
    resolveTagSources(macroTree({ cards: { tag: 'b', limit: 2 } }), lookup, 'me');
    assert.deepEqual(seen, [{ tag: 'b', limit: 2 }, 'me']);
  });

  it('invalid tag source → []', () => {
    const lookup: TagLookup = () => assert.fail('lookup must not run');
    const out = resolveTagSources(macroTree({ cards: { tag: 'b', sort: 'nope' } }), lookup);
    assert.deepEqual(slotsAt(out, 0), { cards: [] });
  });

  it('a tag source written inside a macro definition renders an empty list without throwing', async () => {
    const lib: RenderMacroLib = {
      get: (n) =>
        n === 'outer'
          ? {
              defaults: {},
              tree: { type: 'macro', macro: 'cards', slots: { cards: { tag: 'b' } } }
            }
          : n === 'cards'
            ? {
                defaults: {},
                tree: {
                  type: 'grid',
                  slots: { each: 'cards' },
                  children: [{ type: 'text', markdown: '{{title}}' }]
                }
              }
            : undefined
    };
    const ctx = {
      images: new Map() as ImageMap,
      videos: new Map() as VideoMapView,
      widgets: new WidgetRegistry()
    };
    const html = await renderBlockTree(
      { version: 1, body: [{ type: 'macro', macro: 'outer' }] },
      ctx,
      lib
    );
    assert.doesNotMatch(html, /rkr-grid-cell/);
  });
});
