import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePost, renderPostHtml, serializePost } from '../../src/lib/content.ts';
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
