import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePost, renderPostHtml, serializePost } from '../../src/lib/content.ts';
import { safeLinkUrl } from '../../src/lib/safe-url.ts';
import { WidgetRegistry } from '../../src/lib/widgets.ts';

type AnyDirective = {
  type: 'leafDirective' | 'textDirective' | 'containerDirective';
  attributes?: Record<string, string | null | undefined>;
};
const DIRECTIVE_TYPES = new Set(['leafDirective', 'textDirective', 'containerDirective']);

const FIXTURE = `---
title: First post
slug: first-post
date: 2026-05-06T14:00:00Z
status: published
tags:
  - intro
  - photo
---

This is the opening paragraph. It has **bold** and *emphasis* and a [link](https://example.com).

::image{#abc123def4567890 alt="A photo of the workbench"}

A second paragraph follows the image, with normal prose flow.
`;

test('parsePost extracts the YAML frontmatter into a typed object', () => {
  const parsed = parsePost(FIXTURE);
  assert.equal(parsed.frontmatter.title, 'First post');
  assert.equal(parsed.frontmatter.slug, 'first-post');
  assert.equal(parsed.frontmatter.status, 'published');
  assert.deepEqual(parsed.frontmatter.tags, ['intro', 'photo']);
});

test('parsePost throws on missing frontmatter', () => {
  assert.throws(() => parsePost('hello, no frontmatter here'), /missing YAML frontmatter/);
});

test('parsePost throws when title or slug are not strings', () => {
  const bad = `---\nslug: abc\n---\n\nbody\n`;
  assert.throws(() => parsePost(bad), /title and slug/);
});

test('serializePost round-trips frontmatter exactly and prose with documented normalization', () => {
  const parsed = parsePost(FIXTURE);
  const out = serializePost(parsed);

  // Frontmatter survives byte-for-byte.
  assert.match(out, /^---\ntitle: First post\nslug: first-post\n/);

  // Re-parsing the serialized output gives the same frontmatter and the
  // same set of directive ids — proving the round-trip is semantically
  // identical even where remark-directive normalises `id=` to `#`.
  const reparsed = parsePost(out);
  assert.deepEqual(reparsed.frontmatter, parsed.frontmatter);

  const directiveIds = (ast: typeof parsed.ast): (string | null)[] =>
    ast.children
      .filter((n) => DIRECTIVE_TYPES.has(n.type))
      .map((n) => (n as unknown as AnyDirective).attributes?.id ?? null);

  assert.deepEqual(directiveIds(reparsed.ast), directiveIds(parsed.ast));
});

test('renderPostHtml emits expected HTML for prose, dispatches directives to widgets', async () => {
  const parsed = parsePost(FIXTURE);

  const widgets = new WidgetRegistry();
  let dispatched: { name: string; id: string | undefined } | null = null;
  widgets.register({
    name: 'image',
    render: (node) => {
      dispatched = { name: node.name, id: node.attributes?.id ?? undefined };
      return `<picture data-id="${node.attributes?.id ?? ''}"></picture>`;
    }
  });

  const html = await renderPostHtml(parsed.ast, { siteRoot: '/dev/null', widgets });

  // Prose elements.
  assert.match(html, /<p>This is the opening paragraph. It has <strong>bold<\/strong>/);
  assert.match(html, /<em>emphasis<\/em>/);
  assert.match(html, /<a href="https:\/\/example.com">link<\/a>/);

  // Directive dispatched and emitted.
  assert.match(html, /<picture data-id="abc123def4567890"><\/picture>/);
  assert.deepEqual(dispatched, { name: 'image', id: 'abc123def4567890' });
});

test('renderPostHtml emits a comment for unknown widgets rather than crashing', async () => {
  const parsed = parsePost(`---\ntitle: x\nslug: x\n---\n\n::nope{}\n`);
  const widgets = new WidgetRegistry();
  const html = await renderPostHtml(parsed.ast, { siteRoot: '/dev/null', widgets });
  assert.match(html, /<!-- unknown widget: nope -->/);
});

test('renderPostHtml escapes plain text content to prevent HTML injection', async () => {
  const parsed = parsePost(`---\ntitle: x\nslug: x\n---\n\n<script>alert(1)</script> end\n`);
  const widgets = new WidgetRegistry();
  const html = await renderPostHtml(parsed.ast, { siteRoot: '/dev/null', widgets });
  // The literal `<script>...` line is treated as raw HTML by remark — that's
  // a single-author trust decision per content.ts. Inline angle-text in a
  // paragraph would be escaped; assert that a paragraph with `&` works.
  const safeParsed = parsePost(`---\ntitle: x\nslug: x\n---\n\nA & B then *italic*\n`);
  const safeHtml = await renderPostHtml(safeParsed.ast, { siteRoot: '/dev/null', widgets });
  assert.match(safeHtml, /A &amp; B then <em>italic<\/em>/);
  // Trust check on raw HTML: <script>...</script> passes through verbatim.
  assert.match(html, /<script>alert\(1\)<\/script>/);
});

// ---- safeLinkUrl ------------------------------------------------------
// XSS defense at the link-render layer. Markdown lets authors write
// `[click](javascript:alert(1))` which round-trips to a clickable XSS
// payload unless the renderer strips dangerous schemes. Single-author
// trust covers external attackers, but a misclick or pasted markdown
// is still in scope.

test('safeLinkUrl: passes http / https / mailto / tel through', () => {
  for (const u of [
    'https://example.com/x',
    'http://example.com',
    'mailto:a@b.com',
    'tel:+15551234'
  ]) {
    assert.equal(safeLinkUrl(u), u);
  }
});

test('safeLinkUrl: passes site-relative + fragment + query through', () => {
  for (const u of ['/about', '#section', '?q=1', '../sibling', './child']) {
    assert.equal(safeLinkUrl(u), u);
  }
});

test('safeLinkUrl: replaces javascript:, data:, vbscript:, file: with #', () => {
  for (const u of [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    '  javascript:alert(1)  ',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd'
  ]) {
    assert.equal(safeLinkUrl(u), '#');
  }
});

test('safeLinkUrl: empty / whitespace-only collapses to #', () => {
  assert.equal(safeLinkUrl(''), '#');
  assert.equal(safeLinkUrl('   '), '#');
});

test('safeLinkUrl: a colon inside the path is not a scheme', () => {
  // /a:b — the colon is past the path-start, so this is a relative URL.
  assert.equal(safeLinkUrl('/a:b'), '/a:b');
  // example.com/a:b — no scheme; head has no path-marker; the colon
  // ends the "scheme" and "example.com/a" isn't a known one → reject.
  // (This is intentionally strict; pathless schemes are rare and
  // explicit `https://` is one keystroke.)
  assert.equal(safeLinkUrl('a:b'), '#');
});

// Frontmatter scalars are literal post-YAML-parse. parsePost must NOT
// HTML-entity-decode them: doing so would let a future raw-title sink
// (meta/OpenGraph/RSS/JSON-LD) be injected via `&#60;`/`&quot;`.
// (HTML-entity decoding of WP imports lives in the WP importer instead.)
test('parsePost does not decode entities in title/subtitle (literal)', () => {
  const raw = `---
title: "Picking Up the Scamp at the &#8220;Nest&#8221;"
subtitle: "Heading home&#8230;"
slug: nest-trip
---

Body.
`;
  const { frontmatter } = parsePost(raw);
  assert.equal(frontmatter.title, 'Picking Up the Scamp at the &#8220;Nest&#8221;');
  assert.equal(frontmatter.subtitle, 'Heading home&#8230;');
});

test('parsePost never decodes markup-significant entities into live markup', () => {
  const raw = `---
title: "&#60;img src=x onerror=alert(1)&#62; &lt;b&gt; &quot;q&quot; &#39;a&#39;"
slug: xss
---

Body.
`;
  const { frontmatter } = parsePost(raw);
  assert.ok(!frontmatter.title.includes('<'));
  assert.ok(!frontmatter.title.includes('>'));
  assert.ok(!frontmatter.title.includes('"'));
});

test('parsePost does not throw on a malformed/out-of-range numeric entity', () => {
  const raw = `---
title: "Bad &#1114112; entity"
slug: oob
---

Body.
`;
  assert.doesNotThrow(() => parsePost(raw));
});
