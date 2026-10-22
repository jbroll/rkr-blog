import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BlockTree } from '../../src/lib/blocks.ts';
import { type RenderMacroLib, renderBlockTree } from '../../src/lib/blocks-render.ts';
import type { ImageMap } from '../../src/lib/image-map.ts';
import type { VideoMapView } from '../../src/lib/widgets.ts';
import { WidgetRegistry } from '../../src/lib/widgets.ts';

const emptyLib: RenderMacroLib = { get: () => undefined };

const fakeCtx = {
  images: new Map() as ImageMap,
  videos: new Map() as VideoMapView,
  widgets: new WidgetRegistry()
};

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
});
