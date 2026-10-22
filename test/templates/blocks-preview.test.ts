import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BlockTree } from '../../src/lib/blocks.ts';
import type { ImageMap } from '../../src/lib/image-map.ts';
import type { VideoMapView } from '../../src/lib/widgets.ts';
import { WidgetRegistry } from '../../src/lib/widgets.ts';
import { renderPreviewAtWidths } from '../../src/templates/admin.ts';

const fakeCtx = {
  images: new Map() as ImageMap,
  videos: new Map() as VideoMapView,
  widgets: new WidgetRegistry()
};

const emptyLib = { get: () => undefined };

describe('blocks preview', () => {
  it('renders the same tree at both widths', async () => {
    const tree: BlockTree = { version: 1, body: [{ type: 'text', markdown: 'Hello' }] };
    const [desktop, phone] = await renderPreviewAtWidths(tree, [1200, 390], fakeCtx, emptyLib);
    assert.ok(desktop?.includes('Hello') && phone?.includes('Hello'));
    assert.ok(desktop?.includes('1200') && phone?.includes('390'));
  });

  it('rejects empty width lists', async () => {
    const tree: BlockTree = { version: 1, body: [] };
    assert.deepEqual(await renderPreviewAtWidths(tree, [], fakeCtx, emptyLib), []);
  });
});
