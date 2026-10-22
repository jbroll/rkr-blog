import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { migratePostToTree } from '../../src/lib/markdown-migrate.ts';

describe('markdown-migrate', () => {
  it('maps frontmatter to page fields and body to flow array', () => {
    const tree = migratePostToTree(
      '---\ntitle: T\nslug: t\n---\n\nHello\n\n::figure{ids="ab12cd"}\n'
    );
    assert.equal(tree.body[0]?.type, 'flow');
    assert.equal(tree.fields.title, 'T');
    assert.equal(tree.fields.slug, 't');
  });

  it('maps justify=inline to centered figure', () => {
    const tree = migratePostToTree(
      '---\ntitle: T\nslug: t\n---\n\n::figure{ids="ab12cd" justify="inline"}\n'
    );
    const flow = tree.body[0];
    assert.equal(flow?.type, 'flow');
    const first =
      flow && 'blocks' in flow && Array.isArray(flow.blocks) ? flow.blocks[0] : undefined;
    assert.equal(first?.type, 'figure');
    assert.equal(first?.slots?.justify, 'center');
  });

  it('keeps prose text and never throws on unknown directives', () => {
    const tree = migratePostToTree(
      '---\ntitle: T\nslug: t\n---\n\nSome **bold** words.\n\n::mystery{foo="bar"}\n'
    );
    assert.ok(tree.body.length > 0);
  });
});
