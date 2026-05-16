import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ThreadComment } from '../../src/lib/comments.ts';
import { renderPostPage } from '../../src/templates/post.ts';

function reply(id: number): ThreadComment {
  return {
    id,
    author_name: 'R',
    author_url: null,
    body: 'r',
    created_at: '2026-01-01T00:00:00.000Z',
    replies: []
  };
}
function top(id: number, replies = 0): ThreadComment {
  return {
    id,
    author_name: 'A',
    author_url: null,
    body: 'b',
    created_at: '2026-01-01T00:00:00.000Z',
    replies: Array.from({ length: replies }, (_, i) => reply(id * 100 + i))
  };
}
const base = {
  site: { title: 'rkroll' },
  title: 'Hello',
  slug: 'hello',
  bodyHtml: '<p>x</p>'
} as const;

test('post header has a comment bubble linking to the form with the count', () => {
  const html = renderPostPage({ ...base, comments: [top(1, 2), top(2, 0)] });
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  assert.ok(header.includes('class="rkr-comment-bubble"'), 'bubble in <header>');
  assert.match(header, /href="#respond"/);
  assert.match(header, /aria-label="4 comments — jump to comment form"/);
  assert.match(header, /class="rkr-comment-bubble-count">4</);
  assert.ok(html.includes('id="respond"'));
});

test('bubble pluralises 1 and shows no number at 0', () => {
  const one = renderPostPage({ ...base, comments: [top(1, 0)] });
  assert.match(one, /aria-label="1 comment — jump to comment form"/);
  const none = renderPostPage({ ...base, comments: [] });
  assert.match(none, /aria-label="Leave a comment — jump to comment form"/);
  assert.match(none, /class="rkr-comment-bubble-count"><\/span>/);
  assert.match(none, /class="rkr-comment-bubble"/);
});

test('bubble renders even when comments is undefined', () => {
  const html = renderPostPage({ ...base });
  assert.match(html, /class="rkr-comment-bubble"[^>]*href="#respond"/);
  assert.match(html, /aria-label="Leave a comment — jump to comment form"/);
});
