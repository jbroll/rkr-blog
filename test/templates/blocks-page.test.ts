import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ImageMap } from '../../src/lib/image-map.ts';
import type { VideoMapView } from '../../src/lib/widgets.ts';
import { WidgetRegistry } from '../../src/lib/widgets.ts';
import { renderBlocksPage } from '../../src/templates/blocks.ts';

const fakeCtx = {
  images: new Map() as ImageMap,
  videos: new Map() as VideoMapView,
  widgets: new WidgetRegistry(),
};
void fakeCtx;

describe('blocks page template', () => {
  it('wraps body HTML in site chrome with an escaped title', () => {
    const html = renderBlocksPage({
      site: { title: 'rkroll' },
      assets: { theme: 'default', hash: 'abc', base: '/static' },
      title: 'Hero <demo>',
      bodyHtml: '<section class="rkr-section">Hi</section>\n',
      isAdmin: false,
    });
    assert.match(html, /rkr-site-head/);
    assert.match(html, /rkr-section/);
    assert.match(html, /Hero &lt;demo&gt;/);
  });
});
