import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { cacheKey } from '../../src/lib/hash.ts';
import { ingestStream } from '../../src/lib/originals.ts';
import { type DirectiveNode, WidgetRegistry } from '../../src/lib/widgets.ts';
import imageWidget from '../../src/widgets/image.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-img-widget-'));
  for (const sub of ['sidecars', 'originals']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function makeJpeg() {
  return sharp({
    create: { width: 200, height: 150, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

function directive(id: string, alt = 'caption text'): DirectiveNode {
  return {
    type: 'leafDirective',
    name: 'image',
    attributes: { id, alt },
    children: []
  };
}

test('image widget renders a <picture> with one <source> per format and one fallback <img>', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });

  const widgets = new WidgetRegistry();
  widgets.register(imageWidget);
  const html = await widgets.dispatch('image', directive(r.id), { siteRoot: root, widgets });

  assert.match(html, /^<figure class="rkr-figure rkr-pos-default">/);
  assert.match(html, /<\/figure>$/);
  assert.match(html, /<picture>/);
  assert.match(html, /<\/picture>/);
  // One source per declared format (webp + avif).
  assert.equal((html.match(/<source/g) ?? []).length, 2);
  assert.match(html, /<source type="image\/webp" srcset="[^"]+"/);
  assert.match(html, /<source type="image\/avif" srcset="[^"]+"/);
  // Fallback <img> with the right alt and lazy loading.
  assert.match(html, /<img src="\/img\/[^"]+" alt="caption text" loading="lazy"\/>/);
});

test('image widget srcset URLs match the cacheKey ophashes for declared variants', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });

  const widgets = new WidgetRegistry();
  widgets.register(imageWidget);
  const html = await widgets.dispatch('image', directive(r.id), { siteRoot: root, widgets });

  // For each declared (variant, format), the URL in the srcset must match the
  // ophash computed from {originalId, sidecar.ops, variant, output}.
  for (const v of imageWidget.variants ?? []) {
    for (const fmt of v.formats) {
      const expected = cacheKey({
        originalId: r.id,
        ops: r.sidecar.ops as never,
        variant: { w: v.w } as never,
        output: { format: fmt, quality: fmt === 'avif' ? 70 : 85 } as never
      });
      const url = `/img/${r.id}.${expected}.${fmt} ${v.w}w`;
      assert.ok(html.includes(url), `missing srcset entry: ${url}`);
    }
  }
});

test('image widget emits a comment when the id is missing or invalid', async (t) => {
  const root = freshSiteRoot(t);
  const widgets = new WidgetRegistry();
  widgets.register(imageWidget);

  const noId: DirectiveNode = {
    type: 'leafDirective',
    name: 'image',
    attributes: {},
    children: []
  };
  assert.match(
    await widgets.dispatch('image', noId, { siteRoot: root, widgets }),
    /<!-- image: missing or invalid id -->/
  );

  const badId: DirectiveNode = {
    type: 'leafDirective',
    name: 'image',
    attributes: { id: 'not-hex' },
    children: []
  };
  assert.match(
    await widgets.dispatch('image', badId, { siteRoot: root, widgets }),
    /<!-- image: missing or invalid id -->/
  );
});

test('image widget renders <figcaption> when caption attribute is set', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });

  const widgets = new WidgetRegistry();
  widgets.register(imageWidget);
  const node: DirectiveNode = {
    type: 'leafDirective',
    name: 'image',
    attributes: { id: r.id, alt: 'a photo', caption: 'A wide-angle view of the workbench' },
    children: []
  };
  const html = await widgets.dispatch('image', node, { siteRoot: root, widgets });
  assert.match(html, /<figcaption>A wide-angle view of the workbench<\/figcaption>/);
});

test('image widget skips <figcaption> when caption is absent', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });

  const widgets = new WidgetRegistry();
  widgets.register(imageWidget);
  const html = await widgets.dispatch('image', directive(r.id), { siteRoot: root, widgets });
  assert.equal(html.includes('<figcaption'), false);
});

test('image widget applies the position class', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });

  const widgets = new WidgetRegistry();
  widgets.register(imageWidget);

  for (const position of ['default', 'full', 'left', 'right', 'inline']) {
    const node: DirectiveNode = {
      type: 'leafDirective',
      name: 'image',
      attributes: { id: r.id, position },
      children: []
    };
    const html = await widgets.dispatch('image', node, { siteRoot: root, widgets });
    assert.match(html, new RegExp(`class="rkr-figure rkr-pos-${position}"`));
  }
});

test('image widget falls back to default position when value is invalid', async (t) => {
  const root = freshSiteRoot(t);
  const r = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });

  const widgets = new WidgetRegistry();
  widgets.register(imageWidget);
  const node: DirectiveNode = {
    type: 'leafDirective',
    name: 'image',
    attributes: { id: r.id, position: 'sideways' /* not in the valid set */ },
    children: []
  };
  const html = await widgets.dispatch('image', node, { siteRoot: root, widgets });
  assert.match(html, /class="rkr-figure rkr-pos-default"/);
});

test('image widget emits a comment when the sidecar is missing', async (t) => {
  const root = freshSiteRoot(t);
  const widgets = new WidgetRegistry();
  widgets.register(imageWidget);
  const html = await widgets.dispatch('image', directive('a'.repeat(64)), {
    siteRoot: root,
    widgets
  });
  assert.match(html, /<!-- image: no sidecar for/);
});
