// Cover the less-common content.ts node renderers: list, blockquote,
// code blocks, inline code, image elements, hard breaks, thematic breaks,
// and pass-through HTML.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePost, renderPostHtml } from '../../src/lib/content.ts';
import { WidgetRegistry } from '../../src/lib/widgets.ts';

const ctx = () => ({ siteRoot: '/dev/null', widgets: new WidgetRegistry() });

async function render(body: string): Promise<string> {
  const parsed = parsePost(`---\ntitle: t\nslug: t\n---\n\n${body}\n`);
  return renderPostHtml(parsed.ast, ctx());
}

test('renderPostHtml: ordered and unordered lists', async () => {
  const ul = await render(`- one\n- two`);
  assert.match(ul, /<ul>\n<li>one<\/li>\n<li>two<\/li>\n<\/ul>/);
  const ol = await render(`1. one\n2. two`);
  assert.match(ol, /<ol>\n<li>one<\/li>\n<li>two<\/li>\n<\/ol>/);
});

test('renderPostHtml: blockquote', async () => {
  const html = await render(`> a quote\n> spans lines`);
  assert.match(html, /<blockquote>\n<p>a quote\nspans lines<\/p>\n<\/blockquote>/);
});

test('renderPostHtml: fenced code with language attribute', async () => {
  const html = await render('```js\nconst x = 1;\n```');
  assert.match(html, /<pre><code class="language-js">const x = 1;<\/code><\/pre>/);
});

test('renderPostHtml: inline code', async () => {
  const html = await render('use `foo()` to call it');
  assert.match(html, /<code>foo\(\)<\/code>/);
});

test('renderPostHtml: image element', async () => {
  const html = await render('![alt text](https://example.com/x.png)');
  assert.match(html, /<img src="https:\/\/example.com\/x.png" alt="alt text"\/>/);
});

test('renderPostHtml: thematic break', async () => {
  const html = await render('one\n\n---\n\ntwo');
  assert.match(html, /<hr\/>/);
});

test('renderPostHtml: block-level raw HTML passes through verbatim', async () => {
  // Single-author trust: block-level HTML is emitted as-is.
  // (Inline HTML inside a paragraph is treated as text by remark's defaults.)
  const html = await render('<aside class="x">an aside</aside>');
  assert.match(html, /<aside class="x">an aside<\/aside>/);
});

test('renderPostHtml: hard line break (two trailing spaces)', async () => {
  const html = await render('first  \nsecond');
  assert.match(html, /<br\/>/);
});

test('renderPostHtml: heading levels h1–h6', async () => {
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const hashes = '#'.repeat(n);
    const html = await render(`${hashes} title-${n}`);
    assert.match(html, new RegExp(`<h${n}>title-${n}</h${n}>`));
  }
});
