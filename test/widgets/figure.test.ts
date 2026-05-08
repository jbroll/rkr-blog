// Unit tests for the ::figure widget (Phase 1: matrix=NxM only).
// Covers attribute parsing (matrix, justify, fit, width, aspect),
// rendering shape (figure shell, grid, cells, captions), and
// degenerate cases (no ids, unresolved ids, malformed attrs).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { ingestStream } from '../../src/lib/originals.ts';
import { type DirectiveNode, WidgetRegistry } from '../../src/lib/widgets.ts';
import figureWidget from '../../src/widgets/figure.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-figure-widget-'));
  for (const sub of ['sidecars', 'originals']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function makeJpeg(seed = 0) {
  return sharp({
    create: {
      width: 320 + seed,
      height: 240 + seed,
      channels: 3,
      background: { r: 30 + (seed % 200), g: 60, b: 200 - (seed % 100) }
    }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function ingestN(root: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await ingestStream({
      stream: Readable.from([await makeJpeg(i)]),
      siteRoot: root,
      source: { kind: 'upload', originalName: `pic-${i}.jpg` }
    });
    ids.push(r.id);
  }
  return ids;
}

function makeNode(attributes: Record<string, string>): DirectiveNode {
  return {
    type: 'leafDirective',
    name: 'figure',
    attributes,
    children: []
  };
}

async function dispatch(root: string, attrs: Record<string, string>): Promise<string> {
  const widgets = new WidgetRegistry();
  widgets.register(figureWidget);
  return widgets.dispatch('figure', makeNode(attrs), { siteRoot: root, widgets });
}

test('::figure 1x1 default — single image, defaults applied', async (t) => {
  const root = freshSiteRoot(t);
  const [id] = await ingestN(root, 1);
  const html = await dispatch(root, { ids: id as string });

  // Default justify=center, fit=cover, aspect derived from the image (320×240 = 4:3).
  assert.match(html, /class="rkr-figure rkr-justify-center rkr-fit-cover"/);
  assert.match(html, /--rkr-cell-aspect: 320\/240/);
  assert.match(
    html,
    /<div class="rkr-figure-grid" style="grid-template-columns: repeat\(1, 1fr\); grid-template-rows: repeat\(1, auto\)"/
  );
  assert.match(html, /<div class="rkr-figure-cell"/);
  assert.match(html, /<picture>/);
});

test('::figure matrix=2x3 with 6 images — grid emitted with right shape', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 6);
  const html = await dispatch(root, { ids: ids.join(','), matrix: '2x3' });

  assert.match(
    html,
    /grid-template-columns: repeat\(3, 1fr\); grid-template-rows: repeat\(2, auto\)/
  );
  // Six cells rendered.
  const cellCount = (html.match(/<div class="rkr-figure-cell"/g) ?? []).length;
  assert.equal(cellCount, 6);
});

test('::figure over-allocated matrix renders empty cells (no auto-shrink)', async (t) => {
  // Spec: drop auto-shrink. matrix=2x3 with 2 ids → render 2 cells +
  // 4 implicit-empty grid slots; the grid CSS handles the empty cells.
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 2);
  const html = await dispatch(root, { ids: ids.join(','), matrix: '2x3' });

  assert.match(
    html,
    /grid-template-columns: repeat\(3, 1fr\); grid-template-rows: repeat\(2, auto\)/
  );
  const cellCount = (html.match(/<div class="rkr-figure-cell"/g) ?? []).length;
  assert.equal(cellCount, 2);
});

test('::figure overflow (more ids than cells) drops excess, leaves a comment', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 5);
  const html = await dispatch(root, { ids: ids.join(','), matrix: '1x2' });

  const cellCount = (html.match(/<div class="rkr-figure-cell"/g) ?? []).length;
  assert.equal(cellCount, 2);
  assert.match(html, /<!-- figure: 3 ids exceed matrix capacity; carousel mode/);
});

test('::figure justify=full, fit=contain, width ignored under full', async (t) => {
  const root = freshSiteRoot(t);
  const [id] = await ingestN(root, 1);
  const html = await dispatch(root, {
    ids: id as string,
    justify: 'full',
    fit: 'contain',
    width: '50%'
  });

  assert.match(html, /class="rkr-figure rkr-justify-full rkr-fit-contain"/);
  // width is ignored under full per spec — no width:50% in style
  assert.doesNotMatch(html, /width: 50%/);
});

test('::figure justify=left, explicit width=300px, custom aspect', async (t) => {
  const root = freshSiteRoot(t);
  const [id] = await ingestN(root, 1);
  const html = await dispatch(root, {
    ids: id as string,
    justify: 'left',
    width: '300px',
    aspect: '16:9'
  });

  assert.match(html, /class="rkr-figure rkr-justify-left rkr-fit-cover"/);
  assert.match(html, /style="width: 300px; --rkr-cell-aspect: 16\/9"/);
});

test('::figure aspect malformed → falls back to first image native', async (t) => {
  const root = freshSiteRoot(t);
  const [id] = await ingestN(root, 1);
  const html = await dispatch(root, { ids: id as string, aspect: 'not-an-aspect' });

  // Falls back to 320/240 (the image's native dims).
  assert.match(html, /--rkr-cell-aspect: 320\/240/);
});

test('::figure width without unit is rejected (spec: explicit unit required)', async (t) => {
  const root = freshSiteRoot(t);
  const [id] = await ingestN(root, 1);
  const html = await dispatch(root, { ids: id as string, justify: 'left', width: '300' });

  // No width: declaration → CSS class default takes over.
  assert.doesNotMatch(html, /width: 300/);
});

test('::figure caption (block) + alts + per-image captions', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 2);
  const html = await dispatch(root, {
    ids: ids.join(','),
    matrix: '1x2',
    alts: 'left image,right image',
    captions: 'cap A|cap B',
    caption: 'whole figure'
  });

  assert.match(html, /alt="left image"/);
  assert.match(html, /alt="right image"/);
  // Per-image captions appear in their cells.
  assert.match(html, /cap A/);
  assert.match(html, /cap B/);
  // Block-level <figcaption> appears on the figure.
  assert.match(html, /<figcaption>whole figure<\/figcaption>/);
});

test('::figure justify=inline uses <span> wrapper, drops everything but first id', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 3);
  const html = await dispatch(root, {
    ids: ids.join(','),
    justify: 'inline',
    matrix: '2x2', // ignored under inline
    aspect: '16:9', // ignored under inline
    caption: 'no captions in inline mode'
  });

  // <span> wrapper, not <figure>.
  assert.match(html, /^<span class="rkr-figure rkr-justify-inline/);
  // No grid / no figcaption / no aspect-ratio CSS variable.
  assert.doesNotMatch(html, /rkr-figure-grid/);
  assert.doesNotMatch(html, /<figcaption>/);
  assert.doesNotMatch(html, /--rkr-cell-aspect/);
  // Only the first picture rendered.
  const pics = (html.match(/<picture>/g) ?? []).length;
  assert.equal(pics, 1);
});

test('::figure malformed matrix falls back to 1x1', async (t) => {
  const root = freshSiteRoot(t);
  const [id] = await ingestN(root, 1);
  const html = await dispatch(root, { ids: id as string, matrix: 'not-a-matrix' });

  assert.match(
    html,
    /grid-template-columns: repeat\(1, 1fr\); grid-template-rows: repeat\(1, auto\)/
  );
});

test('::figure unresolved id leaves a placeholder comment', async (t) => {
  const root = freshSiteRoot(t);
  const [id] = await ingestN(root, 1);
  const html = await dispatch(root, {
    ids: `${id},deadbeefdeadbeef`,
    matrix: '1x2'
  });

  const cellCount = (html.match(/<div class="rkr-figure-cell"/g) ?? []).length;
  assert.equal(cellCount, 1);
  assert.match(html, /<!-- figure: unresolved id deadbeefdeadbeef -->/);
});

test('::figure with no resolvable ids returns a single comment', async (t) => {
  const root = freshSiteRoot(t);
  const html = await dispatch(root, { ids: 'deadbeef0000,beefdead0000' });
  assert.match(html, /<!-- figure: no ids resolved -->/);
});

test('::figure with empty ids returns a single comment', async (t) => {
  const root = freshSiteRoot(t);
  const html = await dispatch(root, { ids: '' });
  assert.match(html, /<!-- figure: no valid ids -->/);
});

test('::figure matrix=justified emits a stub comment + 1xN grid (Phase 1)', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 3);
  const html = await dispatch(root, { ids: ids.join(','), matrix: 'justified' });
  assert.match(html, /<!-- figure: matrix=justified not yet implemented/);
  assert.match(
    html,
    /grid-template-columns: repeat\(3, 1fr\); grid-template-rows: repeat\(1, auto\)/
  );
});

test('::figure matrix=masonry:5 emits a stub comment + 1xN grid (Phase 1)', async (t) => {
  const root = freshSiteRoot(t);
  const ids = await ingestN(root, 4);
  const html = await dispatch(root, { ids: ids.join(','), matrix: 'masonry:5' });
  assert.match(html, /<!-- figure: matrix=masonry not yet implemented/);
});
