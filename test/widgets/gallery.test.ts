import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { ingestStream } from '../../src/lib/originals.ts';
import { type DirectiveNode, WidgetRegistry } from '../../src/lib/widgets.ts';
import galleryWidget from '../../src/widgets/gallery.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-gallery-'));
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
  return { type: 'leafDirective', name: 'gallery', attributes: attrs, children: [] };
}

async function dispatch(root: string, attrs: Record<string, string>): Promise<string> {
  const widgets = new WidgetRegistry();
  widgets.register(galleryWidget);
  return widgets.dispatch('gallery', directive(attrs), { siteRoot: root, widgets });
}

test('gallery renders one figure-per-id wrapped in a justified container by default', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 3);
  const html = await dispatch(root, { ids: ids.join(',') });

  assert.match(html, /^<figure class="rkr-gallery rkr-gallery-justified">/);
  assert.match(html, /<\/figure>$/);
  // Three item figures.
  assert.equal((html.match(/class="rkr-gallery-item"/g) ?? []).length, 3);
  // Each item has a srcset (responsive picture).
  assert.equal((html.match(/<source type="image\/webp"/g) ?? []).length, 3);
});

test('gallery accepts layout=masonry and layout=matrix', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 2);
  for (const layout of ['masonry', 'matrix']) {
    const html = await dispatch(root, { ids: ids.join(','), layout });
    assert.match(html, new RegExp(`class="rkr-gallery rkr-gallery-${layout}"`));
  }
});

test('gallery falls back to "justified" when layout value is invalid', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 1);
  const html = await dispatch(root, { ids: ids[0]!, layout: 'bogus' });
  assert.match(html, /rkr-gallery-justified/);
});

test('gallery items carry an --aspect CSS variable from sidecar metadata', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 1, { width: 300, height: 100 }); // aspect 3.0
  const html = await dispatch(root, { ids: ids[0]! });
  assert.match(html, /style="--aspect:3\.0000;"/);
});

test('gallery emits gallery <figcaption> when caption attribute is set', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 2);
  const html = await dispatch(root, {
    ids: ids.join(','),
    caption: 'Three views of the workbench'
  });
  assert.match(html, /<figcaption>Three views of the workbench<\/figcaption>/);
});

test('gallery resolves short id prefixes when unique', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 2);
  // 12-char prefix should be unique among 2 ids.
  const prefix = ids[0]!.slice(0, 12);
  const html = await dispatch(root, { ids: prefix });
  // One item, src URL should reference the full id.
  assert.equal((html.match(/class="rkr-gallery-item"/g) ?? []).length, 1);
  assert.match(html, new RegExp(`/img/${ids[0]}\\.`));
});

test('gallery skips unknown ids with an HTML comment but renders the rest', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 1);
  const fakeId = 'd'.repeat(64);
  const html = await dispatch(root, { ids: `${ids[0]},${fakeId}` });
  assert.match(html, /<!-- gallery: no match for "d{64}" -->/);
  assert.equal((html.match(/class="rkr-gallery-item"/g) ?? []).length, 1);
});

test('gallery returns a comment when ids attribute is missing or empty', async (t) => {
  const root = freshSiteRoot(t);
  assert.match(await dispatch(root, {}), /<!-- gallery: no valid ids -->/);
  assert.match(await dispatch(root, { ids: '' }), /<!-- gallery: no valid ids -->/);
});

test('gallery returns the missing-id comments only, when zero items resolve', async (t) => {
  const root = freshSiteRoot(t);
  const fakeId = 'a'.repeat(64);
  const html = await dispatch(root, { ids: fakeId });
  assert.match(html, /<!-- gallery: no match for/);
  assert.equal(html.includes('rkr-gallery-item'), false);
});

test('gallery dedupes repeated ids (renders one item, not many)', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 1);
  const html = await dispatch(root, { ids: `${ids[0]},${ids[0]},${ids[0]}` });
  // Three references → one rendered item, not three.
  assert.equal((html.match(/class="rkr-gallery-item"/g) ?? []).length, 1);
});

test('gallery silently drops short prefixes that match more than one id', async (t) => {
  const root = freshSiteRoot(t);
  // Plant two hand-crafted sidecars sharing a prefix so the ambiguous
  // branch (matches.length > 1 → null) is genuinely exercised. Ingest-
  // generated ids are sha256 hashes that won't reliably collide on a
  // short prefix, which is why the previous version of this test could
  // only assert "doesn't crash".
  const idA = `aaaaaa${'1'.repeat(58)}`;
  const idB = `aaaaaa${'2'.repeat(58)}`;
  for (const id of [idA, idB]) {
    fs.writeFileSync(
      path.join(root, 'sidecars', `${id}.json`),
      JSON.stringify({
        version: 1,
        original: id,
        source: { kind: 'upload', fetched: '2030-01-01T00:00:00Z' },
        metadata: { width: 100, height: 75, format: 'jpeg' },
        ops: [],
        outputs: [{ format: 'jpeg', quality: 85 }],
        variants: [{ w: 1200 }]
      })
    );
  }
  // 'aaaaaa' is a valid 6-hex prefix, matches both ids, so resolveIds
  // returns null → emits the no-match comment; no item is rendered.
  const html = await dispatch(root, { ids: 'aaaaaa' });
  assert.match(html, /<!-- gallery: no match for "aaaaaa" -->/);
  assert.equal(html.includes('rkr-gallery-item'), false);
});
