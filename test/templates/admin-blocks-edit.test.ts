import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderBlocksEditPage } from '../../src/templates/admin-blocks-edit.ts';

const base = {
  site: { title: 'rkroll' },
  assets: { theme: 'default', hash: 'abc', base: '/admin/static' },
  slug: 'hello',
  bundleUrl: '/admin/static/admin/blocks-page-editor-entry.js?v=abc',
  isAdmin: true
};

/** The embedded tree script's raw text (between the tags). */
function treeScript(html: string): string {
  const match = html.match(/<script type="application\/json" id="rkr-tree">([\s\S]*?)<\/script>/);
  assert.ok(match, 'template emits #rkr-tree');
  return match[1] as string;
}

describe('blocks edit page template', () => {
  it('mounts the editor root with the page slug', () => {
    const html = renderBlocksEditPage(base);
    assert.match(html, /rkr-blocks-edit-root/);
    assert.match(html, /data-slug="hello"/);
    assert.match(html, /blocks-page-editor-entry/);
    assert.match(html, /Edit hello/);
  });

  it('ships View/Edit toggles and a hidden right palette dock', () => {
    const html = renderBlocksEditPage(base);
    assert.match(html, /id="rkr-unified-shell"[^>]*data-mode="view"/);
    assert.match(html, /id="rkr-unified-toolbar"/);
    assert.match(html, /data-mode="view"[^>]*aria-pressed="true"/);
    assert.match(html, /data-mode="edit"[^>]*aria-pressed="false"/);
    assert.match(html, /id="rkr-unified-dock"[^>]*hidden/);
    assert.match(html, /class="rkr-blocks-palette-right"/);
    // Mode CSS: the dock only appears in edit mode.
    assert.match(html, /\.rkr-unified-shell\[data-mode="view"\] \.rkr-blocks-palette-right/);
    assert.match(html, /\.rkr-unified-shell\[data-mode="edit"\]/);
  });

  it('escapes tree JSON so a markdown slot cannot close the script element', () => {
    const tree = {
      version: 1,
      body: [{ type: 'text', markdown: 'before </script><!-- after' }]
    };
    const html = renderBlocksEditPage({ ...base, treeJson: JSON.stringify(tree) });
    const raw = treeScript(html);

    // `<` is escaped in the raw script text, so neither `</script>` nor
    // `<!--` can appear there and the JSON parses back unchanged.
    assert.doesNotMatch(raw, /</);
    assert.match(raw, /\\u003c\/script>/);
    assert.match(raw, /\\u003c!--/);
    assert.deepEqual(JSON.parse(raw), tree);
  });
});
