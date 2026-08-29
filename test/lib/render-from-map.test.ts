// The renderer consumes a prebuilt ImageMap and touches no filesystem,
// so a hand-written map is enough to render a figure.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Sidecar } from '@rkr/image-edit';

import { parsePost, renderPostHtml } from '../../src/lib/content.ts';
import type { ImageMap } from '../../src/lib/image-map.ts';
import { WidgetRegistry } from '../../src/lib/widgets.ts';
import figureWidget from '../../src/widgets/figure.ts';

const SIDECAR: Sidecar = {
  version: 1,
  original: 'a'.repeat(64),
  source: { kind: 'upload' },
  ops: [],
  outputs: [],
  variants: []
};

function mapWith(key: string): ImageMap {
  return new Map([
    [
      key,
      {
        sidecar: SIDECAR,
        width: 1000,
        height: 500,
        urlFor: (w: number, format: string) => `/fake/${key}-${w}.${format}`
      }
    ]
  ]);
}

function ctx(images: ImageMap) {
  const widgets = new WidgetRegistry();
  widgets.register(figureWidget);
  return { images, videos: new Map(), widgets };
}

const POST = (ids: string) => `---
title: t
slug: s
---

::figure{ids="${ids}"}
`;

test('renderPostHtml: renders a figure from a hand-written map with no filesystem access', async () => {
  const id = 'a'.repeat(64);
  const html = await renderPostHtml(parsePost(POST(id)).ast, ctx(mapWith(id)));
  assert.match(html, /<picture>/);
  assert.match(html, /\/fake\/[a]{64}-1200\.jpeg/);
  assert.match(html, /--rkr-image-aspect: 2\.0000/);
});

test('renderPostHtml: an id written as a prefix resolves through the map', async () => {
  const short = 'aaaaaaaa';
  const html = await renderPostHtml(parsePost(POST(short)).ast, ctx(mapWith(short)));
  assert.match(html, /\/fake\/aaaaaaaa-1200\.jpeg/);
});

test('renderPostHtml: an id absent from the map renders the unresolved comment', async () => {
  const html = await renderPostHtml(parsePost(POST('deadbeef')).ast, ctx(new Map()));
  assert.match(html, /<!-- figure: no ids resolved -->/);
});

test('renderPicture collapses to a single <img> when every derivative URL is identical', async () => {
  const id = 'b'.repeat(64);
  const images: ImageMap = new Map([
    [id, { sidecar: SIDECAR, width: 400, height: 400, urlFor: () => 'blob:one' }]
  ]);
  const html = await renderPostHtml(parsePost(POST(id)).ast, ctx(images));
  assert.ok(!html.includes('<source'), 'no <source> when there is one candidate');
  assert.match(html, /<img src="blob:one"/);
});
