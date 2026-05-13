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
  assert.match(html, /<select [^>]*name="status"[^>]*class="rkr-admin-posts-status is-published"/);
  assert.match(html, /<select [^>]*name="status"[^>]*class="rkr-admin-posts-status is-draft"/);
  assert.match(html, /<option value="published" selected>published<\/option>/);
  assert.match(html, /<option value="draft" selected>draft<\/option>/);
  // Pin / delete buttons render the Lucide icons (no text label) —
  // accessible name lives on aria-label.
  assert.match(html, /<button [^>]*data-pin-toggle[^>]*disabled><svg [^>]*>/);
  assert.match(html, /aria-label="Pin Hello for offline editing"/);
  assert.match(html, /class="rkr-admin-posts-del-btn"[^>]*aria-label="Delete Hello"><svg /);
  assert.match(html, /action="\/admin\/posts\/wip\/delete"/);
  assert.match(html, />2026-05-01</);

  // The posts-list bundle is loaded so the status select auto-
  // submits and pin buttons read OPFS. Admin FABs (+ + ⚙) replace
  // the old admin strip; the strip itself is gone.
  assert.match(html, /<script[^>]*src="\/static\/admin\/posts-list\.js"/);
  assert.ok(!html.includes('rkr-admin-strip'), 'admin strip must be gone');
  assert.match(html, /class="rkr-fab[^"]*"[^>]*aria-label="New post"/);
  assert.match(html, /class="rkr-fab[^"]*"[^>]*aria-label="Settings"/);
  // Footer Login/Logout swap shows Logout (authed).
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
