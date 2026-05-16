import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WpFetcher } from '../../src/lib/wp-rest.ts';
import { listComments } from '../../src/lib/wp-rest.ts';

test('listComments returns parsed comments + paging headers', async () => {
  const fetcher: WpFetcher = async (url) => {
    assert.match(url, /\/wp-json\/wp\/v2\/comments\?per_page=100&page=1/);
    return new Response(
      JSON.stringify([
        {
          id: 543,
          post: 2149,
          parent: 0,
          author_name: 'Linda',
          author_url: '',
          date: '2026-05-04T17:00:45',
          content: { rendered: '<p>hi</p>' }
        }
      ]),
      { status: 200, headers: { 'X-WP-Total': '37', 'X-WP-TotalPages': '1' } }
    );
  };
  const r = await listComments('https://roll-along.example/', { page: 1 }, fetcher);
  assert.equal(r.total, 37);
  assert.equal(r.totalPages, 1);
  assert.equal(r.comments[0]?.id, 543);
  assert.equal(r.comments[0]?.post, 2149);
});

test('listComments throws on non-OK', async () => {
  const fetcher: WpFetcher = async () => new Response('nope', { status: 500 });
  await assert.rejects(
    () => listComments('https://x.example', {}, fetcher),
    /WP listComments: 500/
  );
});
