import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type RenderMacroLib, renderBlockTree } from '../../src/lib/blocks-render.ts';
import type { ImageMap, ImageSource } from '../../src/lib/image-map.ts';
import { loadMacroLibrary, seedMacrosDir } from '../../src/lib/macro-library.ts';
import type { VideoMapView } from '../../src/lib/widgets.ts';
import { WidgetRegistry } from '../../src/lib/widgets.ts';
import figureWidget from '../../src/widgets/figure.ts';

const IMG = 'aaaaaa';
const src = {
  sidecar: {},
  width: 320,
  height: 240,
  urlFor: (w: number, f: string) => `/img/${IMG}.${w}.${f}`
} as unknown as ImageSource;

const widgets = new WidgetRegistry();
widgets.register(figureWidget);
const ctx = {
  images: new Map([[IMG, src]]) as ImageMap,
  videos: new Map() as VideoMapView,
  widgets
};

const lib = loadMacroLibrary(seedMacrosDir());
const renderLib: RenderMacroLib = { get: (n) => lib.get(n) };
const render = (macro: string, slots: Record<string, unknown> = {}) =>
  renderBlockTree(
    { version: 1, body: [{ type: 'macro', macro, slots: slots as never }] },
    ctx,
    renderLib
  );

const count = (html: string, re: RegExp): number => (html.match(re) ?? []).length;

describe('seed macro look selects', () => {
  it('a card with no title does not render the band heading', async () => {
    const html = await render('cards', {
      heading: 'Band heading probe',
      cards: [{ text: 'Body only' }, {}]
    });
    assert.equal(count(html, /Band heading probe/g), 1);
    assert.match(html, /Body only/);
  });

  it('defaults keep the shipped look', async () => {
    const hero = await render('hero', { image: IMG });
    assert.match(hero, /rkr-section rkr-theme-dark/);
    assert.match(hero, /rkr-section-wave/);
    assert.match(hero, /rkr-mask-rounded/);
    assert.match(hero, /rkr-align-center/);
    const people = await render('people-grid', { people: [{ photo: IMG, name: 'Ann' }] });
    assert.match(people, /rkr-theme-light/);
    assert.doesNotMatch(people, /rkr-section-wave/);
    assert.match(people, /rkr-mask-circle/);
    assert.equal(count(people, /rkr-align-center/g), 1);
    assert.match(await render('marquee-band'), /rkr-theme-dark-bold/);
    assert.doesNotMatch(await render('cards', { cards: [{ image: IMG }] }), /rkr-mask/);
  });

  it('non-default theme, edge, mask and alignment reach the output', async () => {
    const html = await render('people-grid', {
      theme: 'dark-bold',
      edge: 'wave',
      mask: 'rounded',
      contentAlign: 'start',
      people: [{ photo: IMG, name: 'Ann' }]
    });
    assert.match(html, /rkr-section rkr-theme-dark-bold/);
    assert.match(html, /rkr-section-wave/);
    assert.match(html, /rkr-mask-rounded/);
    assert.doesNotMatch(html, /rkr-mask-circle|rkr-align-center/);
    const square = await render('people-grid', { mask: 'none', people: [{ photo: IMG }] });
    assert.doesNotMatch(square, /rkr-mask/);
    const callout = await render('photo-callout', { contentAlign: 'start' });
    assert.doesNotMatch(callout, /rkr-align-center/);
  });

  it('every band seed offers theme and edge, every figure seed a mask', () => {
    const bands = [
      'hero',
      'photo-callout',
      'marquee-band',
      'cards',
      'people-grid',
      'icon-grid',
      'logo-wall',
      'split'
    ];
    for (const name of bands) {
      const schema = lib.get(name)?.fieldSchema ?? {};
      assert.equal(schema.theme?.type, 'select', `${name} theme`);
      assert.equal(schema.edge?.type, 'select', `${name} edge`);
    }
    for (const name of ['people-grid', 'cards', 'icon-grid', 'split', 'hero']) {
      assert.equal(lib.get(name)?.fieldSchema?.mask?.type, 'select', `${name} mask`);
    }
    for (const name of [
      'hero',
      'photo-callout',
      'people-grid',
      'icon-grid',
      'logo-wall',
      'split'
    ]) {
      assert.equal(lib.get(name)?.fieldSchema?.contentAlign?.type, 'select', `${name} align`);
    }
  });

  it('hero shows a second button only with a label', async () => {
    assert.equal(count(await render('hero'), /class="rkr-btn/g), 1);
    const two = await render('hero', { cta2Label: 'More', cta2Href: '/more' });
    assert.equal(count(two, /class="rkr-btn/g), 2);
    assert.match(two, /href="\/more"/);
  });

  it('marquee-band image becomes the band background; empty renders none', async () => {
    const plain = await render('marquee-band');
    assert.doesNotMatch(plain, /has-bg|rkr-section-bg/);
    assert.match(await render('marquee-band', { image: IMG }), /has-bg/);
  });

  it('cards intro renders under the heading', async () => {
    const html = await render('cards', { heading: 'H', intro: 'Intro *probe*' });
    assert.match(html, /<h2[^>]*>H<\/h2>\s*<p>Intro <em>probe<\/em><\/p>/);
  });
});
