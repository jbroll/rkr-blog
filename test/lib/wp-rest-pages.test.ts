import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WpFetcher } from '../../src/lib/wp-rest.ts';
import { fetchWpPage } from '../../src/lib/wp-rest.ts';

const page = {
  id: 12,
  date: '2020-01-02T00:00:00',
  slug: 'about',
  status: 'publish',
  title: { rendered: 'About' },
  content: { rendered: '<p>hi</p>' }
};

test('fetchWpPage: returns the single matching page', async () => {
  const fetcher: WpFetcher = async (url) => {
    assert.match(url, /\/wp-json\/wp\/v2\/pages\?slug=about&_fields=/);
    return new Response(JSON.stringify([page]), { status: 200 });
  };
  const got = await fetchWpPage('https://wp.example/', 'about', fetcher);
  assert.equal(got.slug, 'about');
  assert.equal(got.content.rendered, '<p>hi</p>');
});

test('fetchWpPage: empty array → throws', async () => {
  const fetcher: WpFetcher = async () => new Response('[]', { status: 200 });
  await assert.rejects(
    () => fetchWpPage('https://wp.example', 'nope', fetcher),
    /no page slug=nope on https:\/\/wp\.example/
  );
});

test('fetchWpPage: non-200 → throws', async () => {
  const fetcher: WpFetcher = async () => new Response('x', { status: 500 });
  await assert.rejects(
    () => fetchWpPage('https://wp.example', 'about', fetcher),
    /WP fetchWpPage: 500/
  );
});
