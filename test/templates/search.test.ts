import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderSearchPage } from '../../src/templates/search.ts';

const base = { site: { title: 'rkroll' } } as const;

test('prompt state when no query', () => {
  const html = renderSearchPage({ ...base, q: '', results: [] });
  assert.match(html, /Type a query/);
  assert.match(html, /<form[^>]*action="\/search"/);
  assert.doesNotMatch(html, /class="rkr-sort-toggle"/);
});

test('no-results state echoes the escaped query', () => {
  const html = renderSearchPage({ ...base, q: '<x>', results: [] });
  assert.match(html, /No results for/);
  assert.match(html, /&lt;x&gt;/);
});

test('renders hits with title link, date, and snippet HTML', () => {
  const html = renderSearchPage({
    ...base,
    q: 'rust',
    results: [
      { slug: 'a', title: 'Alpha', date: '2026-05-01', snippetHtml: 'pre <mark>rust</mark> post' }
    ]
  });
  assert.match(html, /<a href="\/a">Alpha<\/a>/);
  assert.match(html, /<time[^>]*>2026-05-01<\/time>/);
  assert.match(html, /<mark>rust<\/mark>/);
});
