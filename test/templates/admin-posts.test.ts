import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderAdminPostsPage } from '../../src/templates/admin-posts.ts';

test('renderAdminPostsPage: rows show title, status pill, edit + delete', () => {
  const html = renderAdminPostsPage({
    site: { title: 'rkroll' },
    posts: [
      { slug: 'hello', title: 'Hello', status: 'published', updatedAt: '2026-05-01T00:00:00Z' },
      { slug: 'wip', title: 'WIP', status: 'draft', updatedAt: '2026-05-02T00:00:00Z' }
    ]
  });
  assert.match(html, /Hello/);
  assert.match(html, /WIP/);
  assert.match(html, /is-published/);
  assert.match(html, /is-draft/);
  // Edit link routes into the editor with the slug pre-populated.
  assert.match(html, /href="\/admin\/editor\?slug=hello"/);
  // Delete is a form POST so the CSRF / Origin guard catches it.
  assert.match(html, /action="\/admin\/posts\/wip\/delete"/);
  assert.match(html, /method="post"/);
  // Date column reduces ISO to yyyy-mm-dd.
  assert.match(html, />2026-05-01</);
  // siteHead is wired so the admin strip renders.
  assert.match(html, /rkr-admin-strip/);
});

test('renderAdminPostsPage: empty state', () => {
  const html = renderAdminPostsPage({ site: { title: 'rkroll' }, posts: [] });
  assert.match(html, /No posts yet/);
  assert.match(html, /href="\/admin\/editor"/);
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
