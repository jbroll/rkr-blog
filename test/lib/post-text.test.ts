import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePost } from '../../src/lib/content.ts';
import { extractPlainText } from '../../src/lib/post-text.ts';

const md = (body: string) => parsePost(`---\nslug: s\ntitle: T\n---\n\n${body}\n`).ast;

test('collects paragraph text, headings, and inline code', () => {
  const t = extractPlainText(md('# Heading\n\nHello **world** and `code`.'));
  assert.match(t, /Heading/);
  assert.match(t, /Hello/);
  assert.match(t, /world/);
  assert.match(t, /code/);
});

test('skips frontmatter, directives (::figure), and fenced code blocks', () => {
  const t = extractPlainText(
    md('::figure{ids="abc123"}\n\n```js\nconst secret = 1\n```\n\nVisible prose.')
  );
  assert.match(t, /Visible prose/);
  assert.doesNotMatch(t, /abc123/);
  assert.doesNotMatch(t, /secret/);
});

test('returns empty string for an empty body', () => {
  assert.equal(extractPlainText(md('')).trim(), '');
});
