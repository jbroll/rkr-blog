import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { ingestStream } from '../../src/lib/originals.ts';
import { type DirectiveNode, WidgetRegistry } from '../../src/lib/widgets.ts';
import { diptychWidget, triptychWidget } from '../../src/widgets/diptych.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-diptych-'));
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

function directive(name: string, attrs: Record<string, string>): DirectiveNode {
  return { type: 'leafDirective', name, attributes: attrs, children: [] };
}

async function dispatchDip(root: string, attrs: Record<string, string>): Promise<string> {
  const widgets = new WidgetRegistry();
  widgets.register(diptychWidget);
  return widgets.dispatch('diptych', directive('diptych', attrs), { siteRoot: root, widgets });
}

async function dispatchTri(root: string, attrs: Record<string, string>): Promise<string> {
  const widgets = new WidgetRegistry();
  widgets.register(triptychWidget);
  return widgets.dispatch('triptych', directive('triptych', attrs), { siteRoot: root, widgets });
}

test('diptych renders 2 picture cells inside an rkr-diptych figure', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 2);
  const html = await dispatchDip(root, { ids: ids.join(',') });
  assert.match(html, /^<figure class="rkr-diptych">/);
  assert.match(html, /<\/figure>$/);
  assert.equal((html.match(/<source type="image\/webp"/g) ?? []).length, 2);
  assert.equal((html.match(/<picture>/g) ?? []).length, 2);
});

test('triptych renders 3 picture cells inside an rkr-triptych figure', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 3);
  const html = await dispatchTri(root, { ids: ids.join(',') });
  assert.match(html, /^<figure class="rkr-triptych">/);
  assert.equal((html.match(/<picture>/g) ?? []).length, 3);
});

test('diptych/triptych items carry an --aspect CSS variable from sidecar metadata', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 2, { width: 240, height: 120 }); // aspect 2.0
  const html = await dispatchDip(root, { ids: ids.join(',') });
  assert.match(html, /style="--aspect:2\.0000;"/);
});

test('diptych/triptych emit gallery-level <figcaption> when caption attribute is set', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 2);
  const html = await dispatchDip(root, { ids: ids.join(','), caption: 'Before / after' });
  assert.match(html, /<figcaption>Before \/ after<\/figcaption>/);
});

test('diptych truncates extra ids past slot 2 with a comment', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 4);
  const html = await dispatchDip(root, { ids: ids.join(',') });
  assert.equal((html.match(/<picture>/g) ?? []).length, 2);
  assert.match(html, /<!-- diptych: ignoring 2 extra id\(s\) past slot 2 -->/);
});

test('triptych truncates extra ids past slot 3 with a comment', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 5);
  const html = await dispatchTri(root, { ids: ids.join(',') });
  assert.equal((html.match(/<picture>/g) ?? []).length, 3);
  assert.match(html, /<!-- triptych: ignoring 2 extra id\(s\) past slot 3 -->/);
});

test('diptych renders fewer cells without complaint when ids count is under capacity', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 1);
  const html = await dispatchDip(root, { ids: ids[0]! });
  assert.equal((html.match(/<picture>/g) ?? []).length, 1);
  assert.equal(html.includes('extra id'), false);
});

test('diptych resolves short id prefixes when unique', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 2);
  const prefix = ids[0]!.slice(0, 12);
  const html = await dispatchDip(root, { ids: `${prefix},${ids[1]}` });
  assert.match(html, new RegExp(`/img/${ids[0]}\\.`));
  assert.match(html, new RegExp(`/img/${ids[1]}\\.`));
});

test('diptych skips unknown ids with an HTML comment but renders the rest', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 1);
  const fakeId = 'd'.repeat(64);
  const html = await dispatchDip(root, { ids: `${ids[0]},${fakeId}` });
  assert.match(html, /<!-- diptych: no match for "d{64}" -->/);
  assert.equal((html.match(/<picture>/g) ?? []).length, 1);
});

test('diptych returns a comment when ids attribute is missing or empty', async (t) => {
  const root = freshSiteRoot(t);
  assert.match(await dispatchDip(root, {}), /<!-- diptych: no valid ids -->/);
  assert.match(await dispatchDip(root, { ids: '' }), /<!-- diptych: no valid ids -->/);
});

test('triptych returns a comment when ids attribute is missing or empty', async (t) => {
  const root = freshSiteRoot(t);
  assert.match(await dispatchTri(root, {}), /<!-- triptych: no valid ids -->/);
});

test('diptych returns the missing-id comments only, when zero items resolve', async (t) => {
  const root = freshSiteRoot(t);
  const fakeId = 'a'.repeat(64);
  const html = await dispatchDip(root, { ids: fakeId });
  assert.match(html, /<!-- diptych: no match for/);
  assert.equal(html.includes('rkr-diptych">'), false);
});
