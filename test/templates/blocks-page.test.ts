import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ImageMap } from '../../src/lib/image-map.ts';
import type { VideoMapView } from '../../src/lib/widgets.ts';
import { WidgetRegistry } from '../../src/lib/widgets.ts';
import { renderBlocksIndex, renderBlocksPage } from '../../src/templates/blocks.ts';

const fakeCtx = {
  images: new Map() as ImageMap,
  videos: new Map() as VideoMapView,
  widgets: new WidgetRegistry()
};
void fakeCtx;

describe('blocks page template', () => {
  it('shows the edit pencil only for admins on stored pages', () => {
    const admin = renderBlocksPage({
      site: { title: 'rkroll' },
      assets: { theme: 'default', hash: 'abc', base: '/static' },
      title: 'Hello',
      slug: 'hello',
      bodyHtml: '<p>Hi</p>\n',
      isAdmin: true
    });
    assert.match(admin, /\/admin\/blocks\/edit\/hello/);
    const anon = renderBlocksPage({
      site: { title: 'rkroll' },
      assets: { theme: 'default', hash: 'abc', base: '/static' },
      title: 'Hello',
      slug: 'hello',
      bodyHtml: '<p>Hi</p>\n',
      isAdmin: false
    });
    assert.doesNotMatch(anon, /admin\/blocks\/edit/);
    const demo = renderBlocksPage({
      site: { title: 'rkroll' },
      assets: { theme: 'default', hash: 'abc', base: '/static' },
      title: 'hero',
      bodyHtml: '<p>Hi</p>\n',
      isAdmin: true
    });
    assert.doesNotMatch(demo, /admin\/blocks\/edit/);
  });

  it('wraps body HTML in site chrome with an escaped title', () => {
    const html = renderBlocksPage({
      site: { title: 'rkroll' },
      assets: { theme: 'default', hash: 'abc', base: '/static' },
      title: 'Hero <demo>',
      bodyHtml: '<section class="rkr-section">Hi</section>\n',
      isAdmin: false
    });
    assert.match(html, /rkr-site-head/);
    assert.match(html, /rkr-section/);
    assert.match(html, /Hero &lt;demo&gt;/);
  });

  it('renders an index of stored pages as escaped links', () => {
    const html = renderBlocksIndex([
      { slug: 'b', title: 'Bee <b>' },
      { slug: 'a', title: 'Aye' }
    ]);
    assert.match(html, /post-list/);
    assert.match(html, /\/pages\/b/);
    assert.match(html, /Bee &lt;b&gt;/);
  });
});
