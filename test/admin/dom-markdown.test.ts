// DOM → text-DSL serializer tests. Fixture DOM mirrors what
// renderPostHtml emits for the same markdown (pinned by the
// render-shape test below); domToMarkdown must map it back.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { remark } from 'remark';
import remarkDirective from 'remark-directive';

import { domToMarkdown } from '../../src/admin/dom-markdown.ts';
import { type RenderCtx, renderPostHtml } from '../../src/lib/content.ts';
import { WidgetRegistry } from '../../src/lib/widgets.ts';
import { el, FakeDocument } from './fake-dom.ts';

const doc = new FakeDocument();
const t = (value: string) => doc.createTextNode(value);

function ctx(): RenderCtx {
  return { images: new Map(), videos: new Map(), widgets: new WidgetRegistry() };
}

async function render(md: string): Promise<string> {
  const ast = remark().use(remarkDirective).parse(md);
  return renderPostHtml(ast as Parameters<typeof renderPostHtml>[0], ctx());
}

describe('domToMarkdown', () => {
  it('round-trips bold and italic', () => {
    const p = el(
      doc,
      'p',
      {},
      t('Hello '),
      el(doc, 'strong', {}, t('bold')),
      t(' and '),
      el(doc, 'em', {}, t('ital'))
    );
    assert.equal(domToMarkdown([p] as unknown as Element[]), 'Hello **bold** and *ital*');
  });

  it('round-trips links with safe hrefs', () => {
    const p = el(doc, 'p', {}, el(doc, 'a', { href: 'https://example.com/x' }, t('Roll')));
    assert.equal(domToMarkdown([p] as unknown as Element[]), '[Roll](https://example.com/x)');
  });

  it('drops unsafe link targets instead of emitting them', () => {
    const p = el(doc, 'p', {}, el(doc, 'a', { href: 'javascript:alert(1)' }, t('x')));
    assert.ok(!domToMarkdown([p] as unknown as Element[]).includes('javascript:'));
  });

  it('round-trips unordered lists', () => {
    const ul = el(doc, 'ul', {}, el(doc, 'li', {}, t('a')), el(doc, 'li', {}, t('b')));
    assert.equal(domToMarkdown([ul] as unknown as Element[]), '- a\n- b');
  });

  it('round-trips headings', () => {
    assert.equal(domToMarkdown([el(doc, 'h2', {}, t('Sub'))] as unknown as Element[]), '## Sub');
  });

  it('round-trips inline and fenced code', () => {
    assert.equal(
      domToMarkdown([el(doc, 'p', {}, el(doc, 'code', {}, t('x')))] as unknown as Element[]),
      '`x`'
    );
    assert.equal(
      domToMarkdown([el(doc, 'pre', {}, el(doc, 'code', {}, t('y')))] as unknown as Element[]),
      '```\ny\n```'
    );
  });

  it('mirrors renderPostHtml shapes for the same markdown', async () => {
    // Pins the fixture assumption: if the renderer changes shape,
    // this fails and the fixtures above must be revisited.
    assert.match(
      await render('Hello **bold** and *ital*'),
      /<p>Hello <strong>bold<\/strong> and <em>ital<\/em><\/p>/
    );
    assert.match(
      await render('[Roll](https://example.com/x)'),
      /<a href="https:\/\/example\.com\/x">Roll<\/a>/
    );
    assert.match(await render('- a\n- b'), /<ul>\n<li>a<\/li>\n<li>b<\/li>\n<\/ul>/);
    assert.match(await render('## Sub'), /<h2>Sub<\/h2>/);
    assert.match(await render('`x`'), /<p><code>x<\/code><\/p>/);
    assert.match(await render('```\ny\n```'), /<pre><code>y<\/code><\/pre>/);
  });
});
