import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderAdminPostsPage } from '../../src/templates/admin-posts.ts';

test('renderAdminPostsPage: rows show title, status select, pin + delete', () => {
  const html = renderAdminPostsPage({
    site: { title: 'rkroll' },
    posts: [
      { slug: 'hello', title: 'Hello', status: 'published', updatedAt: '2026-05-01T00:00:00Z' },
      { slug: 'wip', title: 'WIP', status: 'draft', updatedAt: '2026-05-02T00:00:00Z' }
    ]
  });
  assert.match(html, /Hello/);
  assert.match(html, /WIP/);
  // Status is a per-row select wrapped in a form posting to the
  // status-flip endpoint; the is-* class on the select carries the
  // current value for the coloured-pill style.
  assert.match(html, /action="\/admin\/posts\/hello\/status"/);
  assert.match(html, /<select [^>]*name="status"[^>]*class="rkr-admin-posts-status is-published"/);
  assert.match(html, /<select [^>]*name="status"[^>]*class="rkr-admin-posts-status is-draft"/);
  assert.match(html, /<option value="published" selected>published<\/option>/);
  assert.match(html, /<option value="draft" selected>draft<\/option>/);
  // Pin button is rendered disabled; the posts-list bundle enables
  // it after reading OPFS pin state.
  assert.match(html, /<button [^>]*data-pin-toggle[^>]*disabled>pin<\/button>/);
  // Title is the "open in editor" affordance — no separate edit
  // button. Click-through routes into the editor with the slug
  // pre-populated.
  assert.match(html, /<a href="\/admin\/editor\?slug=hello">Hello<\/a>/);
  // Delete is a form POST so the CSRF / Origin guard catches it.
  assert.match(html, /action="\/admin\/posts\/wip\/delete"/);
  assert.match(html, /method="post"/);
  // Date column reduces ISO to yyyy-mm-dd.
  assert.match(html, />2026-05-01</);
  // siteHead is wired so the admin strip renders.
  assert.match(html, /rkr-admin-strip/);
  // The posts-list bundle is loaded so the status select auto-
  // submits on change and the pin button reads OPFS.
  assert.match(html, /<script[^>]*src="\/static\/admin\/posts-list\.js"/);
  // Each action gets its own column so the status / pin / delete
  // controls line up vertically across rows like a real table.
  assert.match(html, /<th>Title<\/th>/);
  assert.match(html, /<th>Updated<\/th>/);
  assert.match(html, /<th class="rkr-admin-posts-action">Status<\/th>/);
  assert.match(html, /<th class="rkr-admin-posts-action">Pin<\/th>/);
  assert.match(html, /<th class="rkr-admin-posts-action">Delete<\/th>/);
  // Each action cell carries the single control it owns.
  assert.match(
    html,
    /<td class="rkr-admin-posts-action">\s*<form [^>]*action="\/admin\/posts\/hello\/status"/
  );
  assert.match(html, /<td class="rkr-admin-posts-action">\s*<button [^>]*data-pin-toggle/);
  assert.match(
    html,
    /<td class="rkr-admin-posts-action">\s*<form [^>]*action="\/admin\/posts\/hello\/delete"/
  );
});

test('renderAdminPostsPage: empty state', () => {
  const html = renderAdminPostsPage({ site: { title: 'rkroll' }, posts: [] });
  assert.match(html, /No posts yet/);
  assert.match(html, /href="\/admin\/editor"/);
  // Empty-state cell spans every column; if we change the column count
  // and forget to update the colspan, the empty row looks misaligned.
  assert.match(html, /colspan="5"/);
});

test('renderAdminPostsPage: slug + title are URL/HTML-escaped', () => {
  const html = renderAdminPostsPage({
    site: { title: 'rkroll' },
    posts: [
      {
        slug: 'tricky',
        title: '<script>alert(1)</script>',
        status: 'draft',
        updatedAt: '2026-05-01T00:00:00Z'
      }
    ]
  });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'title must be HTML-escaped');
  assert.match(html, /&lt;script&gt;/);
});
