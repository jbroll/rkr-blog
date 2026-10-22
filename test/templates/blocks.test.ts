import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseBlockTree } from '../../src/lib/blocks.ts';
import { renderBlockTree } from '../../src/lib/blocks-render.ts';
import type { ImageMap } from '../../src/lib/image-map.ts';
import type { VideoMapView } from '../../src/lib/widgets.ts';
import { WidgetRegistry } from '../../src/lib/widgets.ts';

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'blocks'
);
const emptyLib = { get: () => undefined };
const fakeCtx = {
  images: new Map() as ImageMap,
  videos: new Map() as VideoMapView,
  widgets: new WidgetRegistry()
};

async function renderFixture(name: string): Promise<string> {
  const raw = fs.readFileSync(path.join(fixtureDir, `${name}.json`), 'utf8');
  const macro = JSON.parse(raw) as { tree: unknown };
  const tree = parseBlockTree({ version: 1, body: [macro.tree] });
  return renderBlockTree(tree, fakeCtx, emptyLib);
}

describe('block fixtures', () => {
  it('cards-3 fixture renders three columns with buttons', async () => {
    const html = await renderFixture('cards-3');
    assert.equal((html.match(/rkr-col/g) ?? []).length, 3);
    assert.equal((html.match(/rkr-btn/g) ?? []).length, 3);
  });

  it('hero fixture renders section with wave edge', async () => {
    const html = await renderFixture('hero');
    assert.match(html, /rkr-section/);
    assert.match(html, /rkr-section-wave/);
  });

  it('logo-wall fixture renders four columns', async () => {
    const html = await renderFixture('logo-wall');
    assert.equal((html.match(/rkr-col/g) ?? []).length, 4);
  });
});
