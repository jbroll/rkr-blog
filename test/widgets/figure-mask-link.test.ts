import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ImageSource } from '../../src/lib/image-map.ts';
import { type DirectiveNode, WidgetRegistry } from '../../src/lib/widgets.ts';
import figureWidget from '../../src/widgets/figure.ts';
import { parseHref, parseMask } from '../../src/widgets/figure-attrs.ts';

const src = {
  sidecar: {},
  width: 320,
  height: 240,
  urlFor: (w: number, f: string) => `/i/x-${w}.${f}`
} as unknown as ImageSource;

async function render(attrs: Record<string, string>): Promise<string> {
  const widgets = new WidgetRegistry();
  widgets.register(figureWidget);
  const node: DirectiveNode = {
    type: 'leafDirective',
    name: 'figure',
    attributes: attrs,
    children: []
  };
  const images = new Map([
    ['aaaaaa', src],
    ['bbbbbb', src],
    ['cccccc', src]
  ]);
  return widgets.dispatch('figure', node, { images, videos: new Map(), widgets });
}

const IDS = 'aaaaaa,bbbbbb,cccccc';

test('parseMask accepts circle and rounded only', async () => {
  assert.equal(parseMask('circle'), 'circle');
  assert.equal(parseMask('rounded'), 'rounded');
  assert.equal(parseMask('blob'), null);
  assert.equal(parseMask(undefined), null);
});

test('parseHref returns null for empty or unsafe input', async () => {
  assert.equal(parseHref('/about'), '/about');
  assert.equal(parseHref('  https://example.com/x '), 'https://example.com/x');
  assert.equal(parseHref(''), null);
  assert.equal(parseHref('   '), null);
  assert.equal(parseHref('javascript:alert(1)'), null);
  assert.equal(parseHref(undefined), null);
});

test('mask adds rkr-mask-<m> to every layout shell', async () => {
  const layouts: Record<string, string>[] = [
    { ids: 'aaaaaa' },
    { ids: IDS, matrix: '1x2' },
    { ids: IDS, matrix: 'justified' },
    { ids: IDS, matrix: 'masonry' },
    { ids: 'aaaaaa', justify: 'inline' }
  ];
  for (const attrs of layouts) {
    const html = await render({ ...attrs, mask: 'circle' });
    assert.match(html, /^<(figure|span) class="[^"]*\brkr-mask-circle\b/, JSON.stringify(attrs));
  }
  assert.match(await render({ ids: 'aaaaaa', mask: 'rounded' }), /rkr-mask-rounded/);
});

test('an unknown mask adds no class', async () => {
  assert.doesNotMatch(await render({ ids: 'aaaaaa', mask: 'blob' }), /rkr-mask/);
  assert.doesNotMatch(await render({ ids: 'aaaaaa' }), /rkr-mask/);
});

test('href wraps every cell in a link and drops the lightbox marker', async () => {
  for (const matrix of ['1x3', '1x2', 'justified', 'masonry']) {
    const html = await render({ ids: IDS, matrix, href: '/about' });
    assert.equal((html.match(/<a href="\/about"/g) ?? []).length, 3, matrix);
    assert.doesNotMatch(html, /data-pswp/, matrix);
  }
});

test('inline figure links through too', async () => {
  const html = await render({ ids: 'aaaaaa', justify: 'inline', href: '/about' });
  assert.match(html, /<a href="\/about"/);
  assert.doesNotMatch(html, /data-pswp/);
});

test('without href cells keep the lightbox anchor', async () => {
  assert.match(await render({ ids: 'aaaaaa' }), /data-pswp-width/);
});

test('an unsafe href is dropped and the lightbox stays', async () => {
  const html = await render({ ids: 'aaaaaa', href: 'javascript:alert(1)' });
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /data-pswp-width/);
});

test('href is attribute-escaped', async () => {
  const html = await render({ ids: 'aaaaaa', href: '/a"onmouseover="x' });
  assert.doesNotMatch(html, /"onmouseover/);
});
