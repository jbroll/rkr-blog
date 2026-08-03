// restSource: the WpSource adapter over the REST client. A loopback
// fetcher stands in for a live WordPress install.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WpFetcher } from '../../src/lib/wp-import-types.ts';
import { restSource } from '../../src/lib/wp-source.ts';

function stubFetcher(routes: Record<string, unknown>): WpFetcher {
  return async (url) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' }
    });
  };
}

const POST = {
  id: 5,
  date: '2020-01-02T03:04:05',
  modified: '2020-01-02T03:04:05',
  slug: 'hello',
  status: 'publish',
  title: { rendered: 'Hello' },
  content: { rendered: '<p>Hi</p>' },
  excerpt: { rendered: '' },
  link: 'https://wp.example/hello'
};

test('restSource: listPosts and fetchPost delegate to the REST client', async () => {
  const src = restSource('https://wp.example', stubFetcher({ '/wp/v2/posts': [POST] }));
  const list = await src.listPosts({ perPage: 10 });
  assert.equal(list.total, 1);
  assert.equal(list.posts[0]?.slug, 'hello');
  const one = await src.fetchPost('hello');
  assert.equal(one.id, 5);
  src.close();
});

test('restSource: fetchSiteInfo reads the REST root', async () => {
  const src = restSource(
    'https://wp.example',
    stubFetcher({ '/wp-json/': { name: 'Blog', description: 'Tag' } })
  );
  const info = await src.fetchSiteInfo();
  assert.deepEqual(info, { name: 'Blog', description: 'Tag' });
  src.close();
});

test('restSource: fetchFeaturedMediaUrl returns null for media id 0', async () => {
  const src = restSource('https://wp.example', stubFetcher({}));
  assert.equal(await src.fetchFeaturedMediaUrl(0), null);
  src.close();
});

test('restSource: listComments delegates to the REST client', async () => {
  const comment = {
    id: 1,
    post: 5,
    parent: 0,
    author_name: 'A',
    author_url: '',
    date: '2020-01-02T00:00:00',
    content: { rendered: '<p>hi</p>' }
  };
  const src = restSource('https://wp.example', stubFetcher({ '/wp/v2/comments': [comment] }));
  const r = await src.listComments({ perPage: 10 });
  assert.equal(r.comments[0]?.author_name, 'A');
  src.close();
});

test('restSource: fetchPage delegates to the REST client', async () => {
  const src = restSource('https://wp.example', stubFetcher({ '/wp/v2/pages': [POST] }));
  const page = await src.fetchPage('hello');
  assert.equal(page.slug, 'hello');
  src.close();
});

test('restSource: fetchSiteBannerUrl delegates to the REST client', async () => {
  const fetcher: WpFetcher = async () =>
    new Response('<img src="https://wp.example/cropped-x.jpg">', { status: 200 });
  const src = restSource('https://wp.example', fetcher);
  const url = await src.fetchSiteBannerUrl();
  assert.match(url ?? '', /cropped-x\.jpg/);
  src.close();
});

// fetchImage/fetchTagNames wrap lib/wp-import.ts's default fetchers, which
// go through safeFetch (SSRF-guarded) rather than the injected fetcher.
// A loopback target is rejected before any network I/O, which is enough
// to prove restSource wires the fetchers through.
test('restSource: fetchImage wires up the default image fetcher', async () => {
  const src = restSource('https://wp.example');
  await assert.rejects(() => src.fetchImage('http://127.0.0.1:1/img.jpg'));
  src.close();
});

test('restSource: fetchTagNames wires up the default tag fetcher', async () => {
  const src = restSource('https://wp.example');
  await assert.rejects(() => src.fetchTagNames([1, 2], 'http://127.0.0.1:1/hello'));
  src.close();
});
