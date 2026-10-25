import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BlockTree } from '../../src/lib/blocks.ts';
import {
  collectBlockFigureIds,
  type RenderMacroLib,
  renderBlockTree
} from '../../src/lib/blocks-render.ts';
import type { ImageMap } from '../../src/lib/image-map.ts';
import type { VideoMapView } from '../../src/lib/widgets.ts';
import { WidgetRegistry } from '../../src/lib/widgets.ts';

const emptyLib: RenderMacroLib = { get: () => undefined };

const fakeCtx = {
  images: new Map() as ImageMap,
  videos: new Map() as VideoMapView,
  widgets: new WidgetRegistry()
};

/** Marker comments in document order; each is the node's tree path. */
function markerPaths(html: string): number[][] {
  return [...html.matchAll(/<!--rkr:path=([0-9,]+)-->/g)].map((m) =>
    (m[1] as string).split(',').map(Number)
  );
}

const mark = (p: number[]): string => `<!--rkr:path=${p.join(',')}-->`;

const sectionWithHello: BlockTree = {
  version: 1,
  body: [
    {
      type: 'section',
      children: [
        {
          type: 'row',
          children: [{ type: 'col', children: [{ type: 'text', markdown: 'Hello' }] }]
        }
      ]
    }
  ]
};

describe('blocks-render', () => {
  it('renders section>row>text to nested divs', async () => {
    const html = await renderBlockTree(sectionWithHello, fakeCtx, emptyLib);
    assert.match(html, /rkr-section.*rkr-row.*Hello/s);
  });

  it('renders text markdown bold', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [{ type: 'text', markdown: 'a **b** c' }]
    };
    const html = await renderBlockTree(tree, fakeCtx, emptyLib);
    assert.match(html, /<strong>b<\/strong>/);
  });

  it('renders unknown macro as comment, not 500', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [{ type: 'macro', macro: 'nope' }]
    };
    const html = await renderBlockTree(tree, fakeCtx, emptyLib);
    assert.match(html, /<!-- unknown macro: nope -->/);
  });

  it('renders macro cycle as comment', async () => {
    const cyclicLib: RenderMacroLib = {
      get: (name: string) =>
        name === 'hero' ? { defaults: {}, tree: { type: 'macro', macro: 'hero' } } : undefined
    };
    const tree: BlockTree = { version: 1, body: [{ type: 'macro', macro: 'hero' }] };
    const html = await renderBlockTree(tree, fakeCtx, cyclicLib);
    assert.match(html, /<!-- macro cycle: hero -->/);
  });

  it('renders button leaf as anchor', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [{ type: 'button', slots: { label: 'Join', href: '/join', variant: 'primary' } }]
    };
    const html = await renderBlockTree(tree, fakeCtx, emptyLib);
    assert.match(html, /<a[^>]*href="\/join"[^>]*>Join<\/a>/);
  });

  it('renders marquee, accordion, and progress leaves with escaped text', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'marquee', slots: { text: 'Big <news>' } },
        { type: 'accordion', slots: { items: [{ title: 'Q?', body: 'A & B' }, null] } },
        { type: 'progress', slots: { goal: 200, raised: 50 } },
        { type: 'progress', slots: { raised: 50 } }
      ]
    };
    const html = await renderBlockTree(tree, fakeCtx, emptyLib);
    assert.match(html, /<div class="rkr-marquee"><span>Big &lt;news&gt;<\/span><\/div>/);
    assert.match(html, /<summary>Q\?<\/summary>\nA &amp; B\n<\/details>/);
    assert.match(html, /<details><summary><\/summary>/);
    assert.match(html, /aria-valuenow="25"[^>]*><div class="rkr-progress-bar" style="width: 25%">/);
    assert.match(html, /aria-valuenow="0"/);
  });

  it('embeds allowed hosts, links others, and comments out invalid urls', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'embed', slots: { url: 'https://www.youtube.com/embed/x' } },
        { type: 'embed', slots: { url: 'https://example.com/page' } },
        { type: 'embed', slots: { url: 'not a url' } }
      ]
    };
    const html = await renderBlockTree(tree, fakeCtx, emptyLib);
    assert.match(html, /<iframe class="rkr-embed" src="https:\/\/www\.youtube\.com\/embed\/x"/);
    assert.match(html, /<a href="https:\/\/example\.com\/page">https:\/\/example\.com\/page<\/a>/);
    assert.match(html, /<!-- embed: invalid url -->/);
  });

  it('throws on an unknown block type', async () => {
    const tree = { version: 1, body: [{ type: 'nope' }] } as unknown as BlockTree;
    await assert.rejects(renderBlockTree(tree, fakeCtx, emptyLib), /unknown block type nope/);
  });

  it('markers zip with source order, public output unchanged without mark', async () => {
    // Two top-level leaves then a section wrapping two leaves (a
    // section>… nesting: each child appends its index to the parent path).
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'text', markdown: 'One' },
        { type: 'text', markdown: 'Two' },
        {
          type: 'section',
          children: [
            { type: 'text', markdown: 'Three' },
            { type: 'text', markdown: 'Four' }
          ]
        }
      ]
    };
    const plain = await renderBlockTree(tree, fakeCtx, emptyLib);
    // Today's public output, byte-for-byte.
    assert.equal(
      plain,
      '<p>One</p>\n<p>Two</p>\n<section class="rkr-section rkr-theme-light">\n<div class="rkr-section-inner">\n<p>Three</p>\n<p>Four</p>\n</div>\n</section>\n'
    );

    const marked = await renderBlockTree(tree, fakeCtx, emptyLib, { mark });
    // Markers are invisible HTML comments: removing them restores the
    // exact public output.
    assert.equal(marked.replace(/<!--rkr:path=[0-9,]+-->/g, ''), plain);
    // Document order === source order; the section itself is a node
    // ([2]) as well as its children ([2,0], [2,1]) so the client zip
    // matches the source-tree flattening.
    assert.deepEqual(markerPaths(marked), [[0], [1], [2], [2, 0], [2, 1]]);
  });

  it('macro instance emits one marker (internals unmarked)', async () => {
    const macroLib: RenderMacroLib = {
      get: (name: string) =>
        name === 'hero'
          ? {
              defaults: {},
              tree: {
                type: 'section',
                children: [
                  {
                    type: 'row',
                    children: [{ type: 'col', children: [{ type: 'text', markdown: 'Hero' }] }]
                  }
                ]
              }
            }
          : undefined
    };
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'macro', macro: 'hero' },
        { type: 'text', markdown: 'After' }
      ]
    };
    const plain = await renderBlockTree(tree, fakeCtx, macroLib);
    const marked = await renderBlockTree(tree, fakeCtx, macroLib, { mark });
    assert.equal(marked.replace(/<!--rkr:path=[0-9,]+-->/g, ''), plain);
    assert.deepEqual(markerPaths(marked), [[0], [1]]);
    assert.match(marked, /Hero/);
  });

  it('blank text emits an edit placeholder only when marking', async () => {
    const blank: BlockTree = { version: 1, body: [{ type: 'text', markdown: '' }] };
    const marked = await renderBlockTree(blank, fakeCtx, emptyLib, { mark });
    assert.ok(marked.includes('<!--rkr:path=0-->'));
    assert.ok(marked.includes('data-rkr-blank'));
    assert.equal(await renderBlockTree(blank, fakeCtx, emptyLib), '');
  });

  it('blank text keeps sibling markers aligned and public output unchanged', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'text', markdown: '' },
        { type: 'text', markdown: 'Hi' },
        { type: 'button', slots: { label: 'Go', href: '/go' } }
      ]
    };
    const plain = await renderBlockTree(tree, fakeCtx, emptyLib);
    const marked = await renderBlockTree(tree, fakeCtx, emptyLib, { mark });
    assert.equal(
      marked.replace(/<!--rkr:path=[0-9,]+-->|<p class="rkr-unified-blank"[^>]*><\/p>\n?/g, ''),
      plain
    );
    assert.deepEqual(markerPaths(marked), [[0], [1], [2]]);
  });

  it('collects figure ids including inside macros', () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'figure', slots: { ids: 'aa11, bb22' } },
        { type: 'macro', macro: 'wall' }
      ]
    };
    assert.deepEqual(collectBlockFigureIds(tree), ['aa11, bb22']);
    assert.deepEqual(
      collectBlockFigureIds(tree, (n) =>
        n === 'wall' ? { type: 'figure', slots: { ids: 'cc33' } } : undefined
      ),
      ['aa11, bb22', 'cc33']
    );
    // Cycles terminate.
    assert.deepEqual(
      collectBlockFigureIds({ version: 1, body: [{ type: 'macro', macro: 'loop' }] }, () => ({
        type: 'macro',
        macro: 'loop'
      })),
      []
    );
  });
});
