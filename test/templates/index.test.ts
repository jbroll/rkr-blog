// renderIndexPage doubles as the public homepage AND the admin posts
// list. Anonymous visitors see a plain reverse-chrono list of
// published titles; authed admins see the full posts table (drafts +
// per-row status / pin / delete) with the posts-list.js bundle loaded.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderIndexPage } from '../../src/templates/index.ts';

test('renderIndexPage: anonymous view is a plain <ul.post-list>', () => {
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 1,
    posts: [
      { slug: 'hello', title: 'Hello', date: '2026-05-01T00:00:00Z' },
      { slug: 'older', title: 'Older', date: '2026-04-01T00:00:00Z' }
    ]
  });
  assert.match(html, /<ul class="post-list">/);
  assert.match(html, /<a href="\/hello">Hello<\/a>/);
  assert.match(html, /<a href="\/older">Older<\/a>/);
  // No admin-only chrome.
  assert.doesNotMatch(html, /rkr-admin-posts-status/);
  assert.doesNotMatch(html, /data-pin-toggle/);
  assert.doesNotMatch(html, /\/static\/admin\/posts-list\.js/);
});

test('renderIndexPage: admin view renders the posts table with status / pin / delete', () => {
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 1,
    isAdmin: true,
    posts: [
      {
        slug: 'hello',
        title: 'Hello',
        status: 'published',
        date: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z'
      },
      {
        slug: 'wip',
        title: 'WIP',
        status: 'draft',
        updatedAt: '2026-05-02T00:00:00Z'
      }
    ]
  });
  // The table is wrapped in an overflow-x scroll container so a
  // wide admin layout doesn't push the body past viewport width
  // (which on iOS Safari sends the fixed-position FABs off-screen).
  assert.match(html, /<div class="rkr-admin-posts-scroll"><table class="rkr-admin-posts">/);
  // No <thead>: title + date + icon-buttons are self-explanatory;
  // each control carries its accessible name via aria-label.
  assert.doesNotMatch(html, /<thead>/);

  // Each post row carries the per-row controls.
  assert.match(html, /<a href="\/hello">Hello<\/a>/);
  assert.match(html, /<a href="\/wip">WIP<\/a>/);
  assert.match(html, /action="\/admin\/posts\/hello\/status"/);
  // Status icon buttons: globe = published, lock = draft. Toggle flips to opposite status.
  assert.match(html, /class="rkr-admin-posts-status-btn is-published"/);
  assert.match(html, /class="rkr-admin-posts-status-btn is-draft"/);
  assert.match(html, /aria-label="Published — click to unpublish"/);
  assert.match(html, /aria-label="Draft — click to publish"/);
  // Hidden input carries the target (opposite) status for the form submit.
  assert.match(html, /<input [^>]*name="status"[^>]*value="draft"/);
  assert.match(html, /<input [^>]*name="status"[^>]*value="published"/);
  // No select element in the status column.
  assert.doesNotMatch(html, /<select [^>]*name="status"/);
  // Pin / delete buttons render the Lucide icons (no text label) —
  // accessible name lives on aria-label.
  assert.match(html, /<button [^>]*data-pin-toggle[^>]*disabled><svg [^>]*>/);
  assert.match(html, /aria-label="Pin Hello for offline editing"/);
  assert.match(html, /class="rkr-admin-posts-del-btn"[^>]*aria-label="Delete Hello"><svg /);
  assert.match(html, /action="\/admin\/posts\/wip\/delete"/);
  assert.match(html, />2026-05-01</);

  // The posts-list bundle is loaded so pin buttons read OPFS. Admin FABs (+ + ⚙) replace
  // the old admin strip; the strip itself is gone.
  assert.match(html, /<script[^>]*src="\/static\/admin\/posts-list\.js/);
  assert.ok(!html.includes('rkr-admin-strip'), 'admin strip must be gone');
  assert.match(html, /class="rkr-fab[^"]*"[^>]*aria-label="New post"/);
  assert.match(html, /class="rkr-fab[^"]*"[^>]*aria-label="Settings"/);
  // Header Login/Logout swap shows Logout (authed).
  assert.match(html, /<form [^>]*action="\/admin\/logout"[^>]*>/);
});

test('renderIndexPage: admin view, empty state', () => {
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 1,
    isAdmin: true,
    posts: []
  });
  assert.match(html, /No posts yet/);
  assert.match(html, /href="\/admin\/editor"/);
  // colspan must span every column so the empty row isn't off-kilter.
  assert.match(html, /colspan="5"/);
});

test('renderIndexPage: dates show date-only when one post per day, date+time when collision', () => {
  // Two distinct days → both render as YYYY-MM-DD only. A third
  // post on 2026-05-01 collides with `hello` → both 2026-05-01
  // entries gain a HH:MM disambiguator; the lone 2026-04-01 entry
  // stays date-only.
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 1,
    posts: [
      { slug: 'hello', title: 'Hello', date: '2026-05-01T09:15:00Z' },
      { slug: 'hello-pm', title: 'Hello Afternoon', date: '2026-05-01T14:30:00Z' },
      { slug: 'older', title: 'Older', date: '2026-04-01T00:00:00Z' }
    ]
  });
  // Lone day stays clean.
  assert.match(html, /<time datetime="2026-04-01T00:00:00Z">2026-04-01<\/time>/);
  // Colliding day pulls HH:MM in.
  assert.match(html, /<time datetime="2026-05-01T09:15:00Z">2026-05-01 09:15<\/time>/);
  assert.match(html, /<time datetime="2026-05-01T14:30:00Z">2026-05-01 14:30<\/time>/);
  // No raw ISO strings leak into the rendered label.
  assert.doesNotMatch(html, />2026-05-01T09:15:00Z</);
});

test('renderIndexPage: admin date column shows publication date over updatedAt for published posts', () => {
  // WP-imported posts have a correct `date` (original publication) but
  // `updatedAt` reflects the import time (which may be much later).
  // The date column should show `date` so published posts display their
  // real publication date, not the import/deploy timestamp.
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 1,
    isAdmin: true,
    posts: [
      {
        slug: 'wp-post',
        title: 'WP Post',
        status: 'published',
        date: '2024-03-15T12:00:00Z', // original WP pub date
        updatedAt: '2026-05-15T00:03:42Z' // import timestamp
      },
      {
        slug: 'draft-no-date',
        title: 'Draft',
        status: 'draft',
        updatedAt: '2026-05-15T00:04:00Z' // last save; no pub date
      }
    ]
  });
  // Published post shows its publication date, not the import timestamp.
  assert.match(html, /<time datetime="2024-03-15T12:00:00Z">2024-03-15<\/time>/);
  assert.doesNotMatch(html, /2026-05-15T00:03:42/);
  // Draft with no date falls back to updatedAt.
  assert.match(html, /<time datetime="2026-05-15T00:04:00Z">2026-05-15<\/time>/);
});

test('renderIndexPage: admin Updated column also disambiguates same-day rows', () => {
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 1,
    isAdmin: true,
    posts: [
      {
        slug: 'a',
        title: 'A',
        status: 'published',
        updatedAt: '2026-05-13T08:00:00Z'
      },
      {
        slug: 'b',
        title: 'B',
        status: 'published',
        updatedAt: '2026-05-13T16:45:00Z'
      },
      {
        slug: 'c',
        title: 'C',
        status: 'draft',
        updatedAt: '2026-05-14T10:00:00Z'
      }
    ]
  });
  assert.match(html, /<time datetime="2026-05-13T08:00:00Z">2026-05-13 08:00<\/time>/);
  assert.match(html, /<time datetime="2026-05-13T16:45:00Z">2026-05-13 16:45<\/time>/);
  assert.match(html, /<time datetime="2026-05-14T10:00:00Z">2026-05-14<\/time>/);
});

test('renderIndexPage: admin row title + slug are URL/HTML-escaped', () => {
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 1,
    isAdmin: true,
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

// ---------------------------------------------------------------------------
// Tag rail tests
// ---------------------------------------------------------------------------

test('renderIndexPage: tag rail renders when tagCounts provided', () => {
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 1,
    posts: [],
    tagCounts: [
      { name: 'travel', count: 12 },
      { name: 'food', count: 3 }
    ]
  });
  assert.match(html, /<aside class="rkr-tag-rail"/);
  assert.match(html, /aria-label="Tags"/);
  assert.match(html, /href="\/\?tag=travel"/);
  assert.match(html, /travel \(12\)/);
  assert.match(html, /href="\/\?tag=food"/);
  assert.match(html, /food \(3\)/);
});

test('renderIndexPage: no tag rail when tagCounts is empty', () => {
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 1,
    posts: [],
    tagCounts: []
  });
  assert.doesNotMatch(html, /rkr-tag-rail/);
});

test('renderIndexPage: no tag rail when tagCounts is absent', () => {
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 1,
    posts: []
  });
  assert.doesNotMatch(html, /rkr-tag-rail/);
});

test('renderIndexPage: active tag gets aria-current and toggles off on click', () => {
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 1,
    posts: [],
    tagCounts: [
      { name: 'travel', count: 12 },
      { name: 'food', count: 3 }
    ],
    activeTags: ['travel']
  });
  assert.match(html, /aria-current="page"/);
  // Active pill links to / (toggle off) — no separate "clear" link needed.
  assert.match(html, /href="\/"[^>]*aria-current="page"/);
  assert.doesNotMatch(html, /class="rkr-tag-clear"/, 'no separate clear link');
  // Inactive tag has no aria-current
  assert.doesNotMatch(html, /href="\/\?tag=food"[^>]*aria-current/);
});

test('renderIndexPage: pager preserves ?tag= when active', () => {
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 3,
    posts: [],
    tagCounts: [{ name: 'travel', count: 30 }],
    activeTags: ['travel']
  });
  assert.match(html, /href="\/\?page=2&amp;tag=travel"/);
});

test('renderIndexPage: multi-tag AND — active pills toggle off individually', () => {
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 1,
    posts: [],
    tagCounts: [
      { name: 'travel', count: 12 },
      { name: 'food', count: 3 },
      { name: 'hiking', count: 5 }
    ],
    activeTags: ['travel', 'food']
  });
  // Both travel and food pills are active (aria-current).
  assert.match(html, /href="\/\?tag=food"[^>]*aria-current="page"/);
  assert.match(html, /href="\/\?tag=travel"[^>]*aria-current="page"/);
  // Clicking 'travel' (to deselect) → links to /?tag=food (keeps food).
  assert.match(html, /href="\/\?tag=food"[^>]*aria-current="page"/);
  // Clicking 'food' (to deselect) → links to /?tag=travel (keeps travel).
  assert.match(html, /href="\/\?tag=travel"[^>]*aria-current="page"/);
  // Inactive tag 'hiking' links to add it to the selection.
  assert.match(html, /href="\/\?tag=travel&amp;tag=food&amp;tag=hiking"/);
  // No aria-current on hiking.
  assert.doesNotMatch(html, /href="\/\?tag=travel&amp;tag=food&amp;tag=hiking"[^>]*aria-current/);
});

test('renderIndexPage: pager preserves multiple ?tag= params', () => {
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 3,
    posts: [],
    tagCounts: [
      { name: 'travel', count: 30 },
      { name: 'food', count: 10 }
    ],
    activeTags: ['travel', 'food']
  });
  assert.match(html, /href="\/\?page=2&amp;tag=travel&amp;tag=food"/);
});

test('renderIndexPage: sort toggle renders asc/desc links (icon only, no text)', () => {
  const descHtml = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 1,
    posts: [],
    sort: 'desc'
  });
  // desc view: link to switch to asc
  assert.match(descHtml, /href="\/\?sort=asc"/);
  assert.doesNotMatch(descHtml, /href="\/\?sort=desc"/);
  // icon only — no text label
  assert.doesNotMatch(descHtml, /oldest first|newest first/);

  const ascHtml = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 1,
    posts: [],
    sort: 'asc'
  });
  // asc view: link to switch to desc (or back to default)
  assert.match(ascHtml, /href="\/(\?sort=desc)?"/);
  assert.doesNotMatch(ascHtml, /href="\/\?sort=asc"/);
  assert.doesNotMatch(ascHtml, /oldest first|newest first/);
});

test('renderIndexPage: sort toggle preserves ?tag= param', () => {
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 1,
    posts: [],
    tagCounts: [{ name: 'travel', count: 5 }],
    activeTags: ['travel'],
    sort: 'asc'
  });
  // toggle back to desc should keep tag
  assert.match(html, /href="\/\?tag=travel"/);
});

test('renderIndexPage: admin sort toggle is a button with data-sort-toggle, no text label', () => {
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 1,
    isAdmin: true,
    posts: []
  });
  assert.match(html, /<button[^>]*data-sort-toggle/);
  assert.doesNotMatch(html, /oldest first|newest first/);
  assert.doesNotMatch(html, /href="\/\?sort=asc"/);
});

test('renderIndexPage: pager preserves ?sort= when asc', () => {
  const html = renderIndexPage({
    site: { title: 'rkroll' },
    page: 1,
    totalPages: 3,
    posts: [],
    sort: 'asc'
  });
  assert.match(html, /href="\/\?page=2&amp;sort=asc"/);
});
