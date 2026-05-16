import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ThreadComment } from '../../src/lib/comments.ts';
import { renderCommentForm, renderCommentList } from '../../src/templates/comments.ts';

test('renderCommentList escapes author and body and nests one reply level', () => {
  const thread: ThreadComment[] = [
    {
      id: 1,
      author_name: '<script>x</script>',
      body: 'hello & <b>world</b>',
      created_at: '2026-05-01T00:00:00.000Z',
      replies: [
        {
          id: 2,
          author_name: 'Bob',
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
  assert.match(html, /class="rkr-comment-replies"/);
});

test('renderCommentList shows an empty-state when there are no comments', () => {
  assert.match(renderCommentList([]), /No comments yet/);
});

test('renderCommentList never renders the author name as a link', () => {
  const thread: ThreadComment[] = [
    {
      id: 3,
      author_name: 'Jane',
      body: 'text',
      created_at: '2026-05-03T00:00:00.000Z',
      replies: []
    }
  ];
  const html = renderCommentList(thread);
  assert.ok(html.includes('Jane'));
  assert.ok(!html.includes('<a href'));
});

test('renderCommentForm has only name/email/comment + hidden honeypot, no website field', () => {
  const html = renderCommentForm('my-post', { replyTo: 42 });
  assert.match(html, /action="\/my-post\/comments"/);
  assert.match(html, /name="t"/);
  assert.match(html, /name="parent_id" value="42"/);
  assert.match(html, /name="name"/);
  assert.match(html, /name="email"/);
  assert.match(html, /name="body"/);
  // honeypot retained (hidden via static/base.css .rkr-hp)
  assert.match(html, /class="rkr-hp"/);
  assert.match(html, /name="website"/);
  // the real "Website" input is gone
  assert.ok(!html.includes('name="url"'));
  // placeholder-based inputs (no visible <label> wrappers); accessible
  // name preserved via aria-label; grid hooks moved onto the inputs
  assert.match(html, /<input class="rkr-cf-name"[^>]*placeholder="Name"[^>]*aria-label="Name"/);
  assert.match(
    html,
    /<input class="rkr-cf-email"[^>]*placeholder="Email \(never shown\)"[^>]*aria-label="Email \(never shown\)"/
  );
  assert.match(
    html,
    /<textarea class="rkr-cf-comment"[^>]*placeholder="Comment"[^>]*aria-label="Comment"/
  );
  assert.match(html, /<button class="rkr-cf-submit" type="submit">Post<\/button>/);
  // no visible field labels remain (honeypot label is inside .rkr-hp only)
  assert.ok(!html.includes('<label class='));
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
