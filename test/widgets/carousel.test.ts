import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { ingestStream } from '../../src/lib/originals.ts';
import { type DirectiveNode, WidgetRegistry } from '../../src/lib/widgets.ts';
import carouselWidget from '../../src/widgets/carousel.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-carousel-'));
  for (const sub of ['sidecars', 'originals']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function makeJpeg(seed: number, width = 100, height = 75): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: (seed * 13) & 0xff, g: (seed * 29) & 0xff, b: (seed * 47) & 0xff }
    }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function ingestN(
  root: string,
  n: number,
  opts: { width?: number; height?: number } = {}
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await ingestStream({
      stream: Readable.from([await makeJpeg(i, opts.width, opts.height)]),
      siteRoot: root,
      source: { kind: 'upload', originalName: `pic-${i}.jpg` }
    });
    ids.push(r.id);
  }
  return ids;
}

function directive(attrs: Record<string, string>): DirectiveNode {
  return { type: 'leafDirective', name: 'carousel', attributes: attrs, children: [] };
}

async function dispatch(root: string, attrs: Record<string, string>): Promise<string> {
  const widgets = new WidgetRegistry();
  widgets.register(carouselWidget);
  return widgets.dispatch('carousel', directive(attrs), { siteRoot: root, widgets });
}

test('carousel renders track + slides + nav with prev/next/dots', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 3);
  const html = await dispatch(root, { ids: ids.join(',') });

  assert.match(html, /^<figure class="rkr-carousel" tabindex="0" aria-roledescription="carousel"/);
  assert.match(html, /<\/figure>$/);
  assert.match(html, /<div class="rkr-carousel-track" role="list">/);
  assert.equal((html.match(/class="rkr-carousel-slide"/g) ?? []).length, 3);
  assert.equal((html.match(/<source type="image\/webp"/g) ?? []).length, 3);
  assert.equal((html.match(/class="rkr-carousel-dot"/g) ?? []).length, 3);
  assert.match(html, /class="rkr-carousel-prev"/);
  assert.match(html, /class="rkr-carousel-next"/);
});

test('carousel slides carry data-index and --aspect from sidecar metadata', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 2, { width: 200, height: 100 }); // aspect 2.0
  const html = await dispatch(root, { ids: ids.join(',') });

  assert.match(html, /data-index="0"/);
  assert.match(html, /data-index="1"/);
  assert.match(html, /style="--aspect:2\.0000;"/);
});

test('carousel emits a figcaption when caption attribute is set', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 2);
  const html = await dispatch(root, {
    ids: ids.join(','),
    caption: 'Three views of a workbench'
  });
  assert.match(html, /<figcaption>Three views of a workbench<\/figcaption>/);
});

test('carousel autoplay attribute drives data-autoplay and a play/pause button', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 2);
  const html = await dispatch(root, { ids: ids.join(','), autoplay: '5' });
  assert.match(html, /data-autoplay="5"/);
  assert.match(html, /class="rkr-carousel-play"/);
  assert.match(html, /aria-label="Pause slideshow"/);
});

test('carousel without autoplay omits data-autoplay and the play button', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 2);
  const html = await dispatch(root, { ids: ids.join(',') });
  assert.equal(html.includes('data-autoplay'), false);
  assert.equal(html.includes('rkr-carousel-play'), false);
});

test('carousel autoplay is capped at 60 seconds and floors invalid input to 0', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 2);
  const big = await dispatch(root, { ids: ids.join(','), autoplay: '999' });
  assert.match(big, /data-autoplay="60"/);

  const bogus = await dispatch(root, { ids: ids.join(','), autoplay: 'fast' });
  assert.equal(bogus.includes('data-autoplay'), false);

  const negative = await dispatch(root, { ids: ids.join(','), autoplay: '-5' });
  assert.equal(negative.includes('data-autoplay'), false);
});

test('carousel resolves short id prefixes when unique', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 2);
  const prefix = ids[0]!.slice(0, 12);
  const html = await dispatch(root, { ids: prefix });
  assert.equal((html.match(/class="rkr-carousel-slide"/g) ?? []).length, 1);
  assert.match(html, new RegExp(`/img/${ids[0]}\\.`));
});

test('carousel skips unknown ids with an HTML comment but renders the rest', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 1);
  const fakeId = 'd'.repeat(64);
  const html = await dispatch(root, { ids: `${ids[0]},${fakeId}` });
  assert.match(html, /<!-- carousel: no match for "d{64}" -->/);
  assert.equal((html.match(/class="rkr-carousel-slide"/g) ?? []).length, 1);
});

test('carousel returns a comment when ids attribute is missing or empty', async (t) => {
  const root = freshSiteRoot(t);
  assert.match(await dispatch(root, {}), /<!-- carousel: no valid ids -->/);
  assert.match(await dispatch(root, { ids: '' }), /<!-- carousel: no valid ids -->/);
});

test('carousel returns the missing-id comments only, when zero items resolve', async (t) => {
  const root = freshSiteRoot(t);
  const fakeId = 'a'.repeat(64);
  const html = await dispatch(root, { ids: fakeId });
  assert.match(html, /<!-- carousel: no match for/);
  assert.equal(html.includes('rkr-carousel-slide'), false);
});
