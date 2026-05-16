import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ThreadComment } from '../../src/lib/comments.ts';
import { renderCommentForm, renderCommentList } from '../../src/templates/comments.ts';

test('renderCommentList escapes author and body and nests one reply level', () => {
  const thread: ThreadComment[] = [
    {
      id: 1,
      author_name: '<script>x</script>',
      author_url: null,
      body: 'hello & <b>world</b>',
      created_at: '2026-05-01T00:00:00.000Z',
      replies: [
        {
          id: 2,
          author_name: 'Bob',
          author_url: 'http://bob.example',
          body: 'reply',
          created_at: '2026-05-02T00:00:00.000Z',
          replies: []
        }
      ]
    }
  ];
  const html = renderCommentList(thread);
  assert.ok(!html.includes('<script>x</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('hello &amp; &lt;b&gt;world&lt;/b&gt;'));
  assert.match(html, /rel="nofollow ugc noopener"/);
  assert.match(html, /class="rkr-comment-replies"/);
});

test('renderCommentList shows an empty-state when there are no comments', () => {
  assert.match(renderCommentList([]), /No comments yet/);
});

test('renderCommentForm includes honeypot + timestamp + reply target', () => {
  const html = renderCommentForm('my-post', { replyTo: 42 });
  assert.match(html, /action="\/my-post\/comments"/);
  assert.match(html, /name="website"/);
  assert.match(html, /name="t"/);
  assert.match(html, /name="parent_id" value="42"/);
  assert.match(html, /name="name"/);
  assert.match(html, /name="email"/);
  assert.match(html, /name="body"/);
});

test('renderCommentList renders author without link when author_url is null', () => {
  const thread: ThreadComment[] = [
    {
      id: 3,
      author_name: 'NoLink',
      author_url: null,
      body: 'text',
      created_at: '2026-05-03T00:00:00.000Z',
      replies: []
    }
  ];
  const html = renderCommentList(thread);
  assert.ok(html.includes('NoLink'));
  assert.ok(!html.includes('<a href'));
});

test('renderCommentList renders author as plain text when url is not http/https', () => {
  const thread: ThreadComment[] = [
    {
      id: 4,
      author_name: 'BadUrl',
      author_url: 'javascript:alert(1)',
      body: 'text',
      created_at: '2026-05-04T00:00:00.000Z',
      replies: []
    }
  ];
  const html = renderCommentList(thread);
  assert.ok(html.includes('BadUrl'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(!html.includes('<a href'));
});

test('renderCommentForm without replyTo omits parent_id', () => {
  const html = renderCommentForm('slug-only');
  assert.ok(!html.includes('parent_id'));
  assert.match(html, /action="\/slug-only\/comments"/);
});

test('renderCommentForm with notice renders notice paragraph', () => {
  const html = renderCommentForm('slug', { notice: 'Thank you & welcome!' });
  assert.match(html, /class="rkr-comment-notice"/);
  assert.ok(html.includes('Thank you &amp; welcome!'));
});
