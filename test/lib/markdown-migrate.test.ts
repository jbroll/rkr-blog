import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderBlockTree } from '../../src/lib/blocks-render.ts';
import type { ImageMap } from '../../src/lib/image-map.ts';
import { migratePostToTree } from '../../src/lib/markdown-migrate.ts';
import { type VideoMapView, WidgetRegistry } from '../../src/lib/widgets.ts';

const ctx = {
  images: new Map() as ImageMap,
  videos: new Map() as VideoMapView,
  widgets: new WidgetRegistry()
};

describe('markdown-migrate', () => {
  it('maps frontmatter to page fields and puts blocks straight in the body', () => {
    const tree = migratePostToTree(
      '---\ntitle: T\nslug: t\n---\n\n::figure{ids="ab12cd"}\n\nHello\n\nWorld\n'
    );
    assert.equal(tree.body[0]?.type, 'figure');
    assert.equal(tree.body.length, 3);
    assert.equal(tree.fields.title, 'T');
    assert.equal(tree.fields.slug, 't');
  });

  it('turns a directive container into a band grid', () => {
    const tree = migratePostToTree('---\ntitle: T\nslug: t\n---\n\n:::box\nInside\n:::\n');
    assert.deepEqual(tree.body[0], {
      type: 'grid',
      slots: { band: true, theme: 'light', edge: 'straight', cols: 1 },
      children: [{ type: 'text', markdown: 'Inside' }]
    });
  });

  it('maps justify=inline to centered figure', () => {
    const tree = migratePostToTree(
      '---\ntitle: T\nslug: t\n---\n\n::figure{ids="ab12cd" justify="inline"}\n'
    );
    const first = tree.body[0];
    assert.equal(first?.type, 'figure');
    assert.equal(first?.slots?.justify, 'center');
  });

  it('keeps prose text and never throws on unknown directives', () => {
    const tree = migratePostToTree(
      '---\ntitle: T\nslug: t\n---\n\nSome **bold** words.\n\n::mystery{foo="bar"}\n'
    );
    assert.ok(tree.body.length > 0);
  });

  it('reference-style links still link after the body splits into blocks', async () => {
    const tree = migratePostToTree(
      '---\ntitle: T\nslug: t\n---\n\nRead [the docs][1] and [guide].\n\nMore text.\n\n[1]: https://example.com/docs "Docs"\n[guide]: https://example.com/guide\n'
    );
    const html = await renderBlockTree(tree, ctx, { get: () => undefined });
    assert.match(html, /<a href="https:\/\/example\.com\/docs"[^>]*>the docs<\/a>/);
    assert.match(html, /<a href="https:\/\/example\.com\/guide"[^>]*>guide<\/a>/);
    assert.doesNotMatch(html, /\[1\]|\[guide\]/);
  });

  it('keeps subtitle and unknown frontmatter keys in fields', () => {
    const tree = migratePostToTree(
      '---\ntitle: T\nslug: t\nsubtitle: A smaller heading\nsource_kind: wordpress\nwp_id: 42\ntags: [news, 2019]\n---\n\nHi\n'
    );
    assert.equal(tree.fields.subtitle, 'A smaller heading');
    assert.equal(tree.fields.source_kind, 'wordpress');
    assert.equal(tree.fields.wp_id, 42);
    assert.deepEqual(tree.fields.tags, ['news', '2019']);
  });

  it('writes lists the way the editor serializes them', () => {
    const tree = migratePostToTree('---\ntitle: T\nslug: t\n---\n\n* one\n* two\n');
    assert.equal((tree.body[0] as { markdown?: string }).markdown, '- one\n- two');
  });
});
