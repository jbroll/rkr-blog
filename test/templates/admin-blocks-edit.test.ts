import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderBlocksEditPage } from '../../src/templates/admin-blocks-edit.ts';

describe('blocks edit page template', () => {
  it('mounts the editor root with the page slug', () => {
    const html = renderBlocksEditPage({
      site: { title: 'rkroll' },
      assets: { theme: 'default', hash: 'abc', base: '/admin/static' },
      slug: 'hello',
      bundleUrl: '/admin/static/admin/blocks-page-editor-entry.js?v=abc',
      isAdmin: true
    });
    assert.match(html, /rkr-blocks-edit-root/);
    assert.match(html, /data-slug="hello"/);
    assert.match(html, /blocks-page-editor-entry/);
    assert.match(html, /Edit hello/);
  });
});
