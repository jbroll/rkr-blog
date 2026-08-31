import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import sharp from 'sharp';
import { parsePost, renderPostHtml } from '../../src/lib/content.ts';
import { buildImageMap } from '../../src/lib/image-map-fs.ts';
import { ingestStream } from '../../src/lib/originals.ts';
import { WidgetRegistry } from '../../src/lib/widgets.ts';
import figureWidget from '../../src/widgets/figure.ts';
import { installMockOpfs } from '../admin/opfs-mock.ts';

const { resetMockOpfs } = installMockOpfs();

/** Strip what the two sides are allowed to disagree on: the URLs
 * themselves, and the srcset the client collapses to one candidate. */
function normalize(html: string): string {
  return html
    .replace(/^[^\S\n]*<source[^>]*\/>\n/gm, '')
    .replace(/(src|href)="[^"]*"/g, '$1="URL"');
}

/** The format → widths matrix the rendered `<source>` elements carry,
 * plus every variant URL, keyed in emission order. normalize() drops
 * the sources before comparing the two halves, so a format or width
 * the server stopped emitting would be invisible there. */
function sourceMatrix(html: string): { matrix: Record<string, string[]>; urls: string[] } {
  const matrix: Record<string, string[]> = {};
  const urls: string[] = [];
  for (const m of html.matchAll(/<source type="image\/([^"]+)" srcset="([^"]*)"\/>/g)) {
    const format = m[1] as string;
    const entries = (m[2] as string).split(', ');
    matrix[format] = entries.map((e) => e.split(' ')[1] as string);
    urls.push(...entries.map((e) => e.split(' ')[0] as string));
  }
  return { matrix, urls };
}

/** The same matrix, derived from the figure widget's declared variants
 * rather than from the HTML. */
function declaredMatrix(): Record<string, string[]> {
  const matrix: Record<string, string[]> = {};
  for (const v of figureWidget.variants ?? []) {
    for (const format of v.formats) {
      matrix[format] = [...(matrix[format] ?? []), `${v.w}w`];
    }
  }
  return matrix;
}

function registry(): WidgetRegistry {
  const w = new WidgetRegistry();
  w.register(figureWidget);
  return w;
}

test('prepass equivalence: one fixture renders identically through both halves', async (t) => {
  resetMockOpfs();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-equiv-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'bakes', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const bytes = await sharp({
    create: { width: 900, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } }
  })
    .jpeg()
    .toBuffer();
  const { id } = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload' }
  });

  const body = `---
title: t
slug: s
---

Some prose with *emphasis*.

::figure{ids="${id.slice(0, 10)}" caption="hello" matrix=1x1}

More prose.
`;

  // Mirror the server's state into OPFS, the way pinPost does.
  const { writeJson, writeBlob } = await import('../../src/admin/opfs.ts');
  const sidecar = JSON.parse(
    fs.readFileSync(path.join(root, 'sidecars', `${id}.json`), 'utf8')
  ) as unknown;
  await writeJson(`sidecars/${id}.json`, sidecar);
  await writeBlob(`originals/${id}.jpg`, new Blob([new Uint8Array(bytes)]));

  const { buildImageMapFromOpfs } = await import('../../src/admin/image-map-opfs.ts');
  const { ast } = parsePost(body);
  const serverHtml = await renderPostHtml(ast, {
    images: await buildImageMap(root, ast),
    videos: new Map(),
    widgets: registry()
  });
  const clientHtml = await renderPostHtml(ast, {
    images: await buildImageMapFromOpfs(ast, {
      decode: async () => ({ width: 900, height: 300 }),
      toUrl: () => 'blob:x'
    }),
    videos: new Map(),
    widgets: registry()
  });

  assert.equal(normalize(clientHtml), normalize(serverHtml));

  // What normalize() stripped: every declared format and width is
  // actually emitted, and each (width, format) pair gets its own
  // cache-keyed URL.
  const { matrix, urls } = sourceMatrix(serverHtml);
  const declared = declaredMatrix();
  assert.deepEqual(Object.keys(declared).sort(), ['avif', 'webp'], 'declared matrix is non-empty');
  assert.deepEqual(matrix, declared);
  assert.equal(new Set(urls).size, urls.length, 'variant URLs are distinct');
  for (const url of urls) {
    assert.match(url, new RegExp(`^/img/${id}\\.[0-9a-f]+\\.(${Object.keys(matrix).join('|')})$`));
  }

  // The client half legitimately has no <source> at all: one blob URL
  // serves every candidate, so renderPicture collapses to the <img>.
  assert.deepEqual(sourceMatrix(clientHtml).matrix, {});
});
