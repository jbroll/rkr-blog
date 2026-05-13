// Unit tests for the service-worker logic. Drives the pure
// handlers in src/site/sw-core.ts against a Map-backed
// CacheStorage stub. Node 22's global fetch / Request / Response
// stand in for browser equivalents; the SW Cache API is mocked
// since Node doesn't ship a `caches` global.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ALL_CACHES,
  type CacheLike,
  type CacheStorageLike,
  cacheFirst,
  cacheWithCap,
  dispatchFetch,
  IMAGES,
  isNoStore,
  PAGES,
  PAGES_CAP,
  runActivate,
  runInstall,
  runMessage,
  SHELL,
  SHELL_PRECACHE
} from '../../src/site/sw-core.ts';

// ---- Cache + CacheStorage stub ------------------------------------

class MockCache implements CacheLike {
  private store: Array<[string, Response]> = [];

  async match(req: Request | string): Promise<Response | undefined> {
    const key = typeof req === 'string' ? req : req.url;
    const entry = this.store.find(([k]) => k === key);
    return entry ? entry[1].clone() : undefined;
  }
  async matchAll(): Promise<readonly Response[]> {
    return this.store.map(([, r]) => r.clone());
  }
  async add(req: Request | string): Promise<void> {
    const url = typeof req === 'string' ? req : req.url;
    await this.put(url, new Response(`mock:${url}`));
  }
  async addAll(reqs: readonly (Request | string)[]): Promise<void> {
    for (const r of reqs) await this.add(r);
  }
  async put(req: Request | string, res: Response): Promise<void> {
    const key = typeof req === 'string' ? req : req.url;
    const idx = this.store.findIndex(([k]) => k === key);
    if (idx >= 0) this.store.splice(idx, 1);
    this.store.push([key, res]);
  }
  async delete(req: Request | string): Promise<boolean> {
    const key = typeof req === 'string' ? req : req.url;
    const idx = this.store.findIndex(([k]) => k === key);
    if (idx < 0) return false;
    this.store.splice(idx, 1);
    return true;
  }
  async keys(): Promise<readonly Request[]> {
    // Node's Request requires absolute URLs; relative cache keys
    // (e.g. precache entries like '/static/manifest.webmanifest')
    // get prefixed with a sentinel origin so the constructor accepts.
    return this.store.map(
      ([k]) => new Request(k.startsWith('http') ? k : `https://sw-test.invalid${k}`)
    );
  }
}

class MockCacheStorage implements CacheStorageLike {
  caches = new Map<string, MockCache>();

  async open(name: string): Promise<MockCache> {
    let c = this.caches.get(name);
    if (!c) {
      c = new MockCache();
      this.caches.set(name, c);
    }
    return c;
  }
  async has(name: string): Promise<boolean> {
    return this.caches.has(name);
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
  async keys(): Promise<readonly string[]> {
    return [...this.caches.keys()];
  }
}

// ---- isNoStore ----------------------------------------------------

test('isNoStore: returns true when Cache-Control header includes no-store', () => {
  const res = new Response('x', { headers: { 'cache-control': 'private, no-store' } });
  assert.equal(isNoStore(res), true);
});

test('isNoStore: case-insensitive match', () => {
  const res = new Response('x', { headers: { 'cache-control': 'No-Store, max-age=0' } });
  assert.equal(isNoStore(res), true);
});

test('isNoStore: false when header is absent or lacks the directive', () => {
  assert.equal(isNoStore(new Response('x')), false);
  assert.equal(isNoStore(new Response('x', { headers: { 'cache-control': 'max-age=60' } })), false);
});

// ---- cacheWithCap -------------------------------------------------

test('cacheWithCap: writes the entry and stays under cap', async () => {
  const cache = new MockCache();
  const req = new Request('https://x/a');
  await cacheWithCap(cache, req, new Response('a'), 10);
  const hit = await cache.match(req);
  assert.ok(hit);
  assert.equal((await cache.keys()).length, 1);
});

test('cacheWithCap: evicts the oldest entry when over cap (FIFO)', async () => {
  const cache = new MockCache();
  const urls = ['https://x/1', 'https://x/2', 'https://x/3'];
  for (const url of urls) {
    await cacheWithCap(cache, new Request(url), new Response(url), 2);
  }
  const keys = await cache.keys();
  // After three inserts with cap=2, the oldest (/1) is gone.
  assert.equal(keys.length, 2);
  assert.deepEqual(
    keys.map((r) => r.url),
    ['https://x/2', 'https://x/3']
  );
});

test('cacheWithCap: cap=Infinity skips the trim', async () => {
  const cache = new MockCache();
  for (let i = 0; i < 5; i++) {
    await cacheWithCap(
      cache,
      new Request(`https://x/${i}`),
      new Response(`${i}`),
      Number.POSITIVE_INFINITY
    );
  }
  assert.equal((await cache.keys()).length, 5);
});

// ---- cacheFirst ---------------------------------------------------

test('cacheFirst: returns cached hit without calling fetch', async () => {
  const caches = new MockCacheStorage();
  const cache = await caches.open(IMAGES);
  const req = new Request('https://x/img/abc.def.webp');
  await cache.put(req, new Response('cached-bytes'));

  let fetched = 0;
  const fakeFetch = (async () => {
    fetched++;
    return new Response('network-bytes');
  }) as typeof fetch;

  const res = await cacheFirst(caches, req, IMAGES, 10, fakeFetch);
  assert.equal(await res.text(), 'cached-bytes');
  assert.equal(fetched, 0);
});

test('cacheFirst: falls back to network on miss + stores the response', async () => {
  const caches = new MockCacheStorage();
  const req = new Request('https://x/img/new.webp');
  const fakeFetch = (async () => new Response('net', { status: 200 })) as typeof fetch;
  const res = await cacheFirst(caches, req, IMAGES, 10, fakeFetch);
  assert.equal(await res.text(), 'net');
  // The cache now holds the entry (eventually — cacheWithCap runs
  // void; let the microtask flush).
  await new Promise((r) => setTimeout(r, 0));
  const cache = await caches.open(IMAGES);
  const hit = await cache.match(req);
  assert.ok(hit);
});

test('cacheFirst: skips caching when network returns non-200', async () => {
  const caches = new MockCacheStorage();
  const req = new Request('https://x/img/missing.webp');
  const fakeFetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
  const res = await cacheFirst(caches, req, IMAGES, 10, fakeFetch);
  assert.equal(res.status, 404);
  await new Promise((r) => setTimeout(r, 0));
  const cache = await caches.open(IMAGES);
  assert.equal((await cache.keys()).length, 0);
});

// ---- staleWhileRevalidate -----------------------------------------

test('staleWhileRevalidate: returns cached hit immediately', async () => {
  const caches = new MockCacheStorage();
  const cache = await caches.open(PAGES);
  const req = new Request('https://x/post');
  await cache.put(req, new Response('cached'));

  let fetchCalled = false;
  const fakeFetch = (async () => {
    fetchCalled = true;
    return new Response('network');
  }) as typeof fetch;

  const { staleWhileRevalidate } = await import('../../src/site/sw-core.ts');
  const res = await staleWhileRevalidate(caches, req, PAGES, PAGES_CAP, fakeFetch);
  assert.equal(await res.text(), 'cached');
  // The revalidation fetch fires in the background — give it a tick.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(fetchCalled, true);
});

test('staleWhileRevalidate: falls through to network on cold cache', async () => {
  const caches = new MockCacheStorage();
  const req = new Request('https://x/cold');
  const fakeFetch = (async () => new Response('net', { status: 200 })) as typeof fetch;
  const { staleWhileRevalidate } = await import('../../src/site/sw-core.ts');
  const res = await staleWhileRevalidate(caches, req, PAGES, PAGES_CAP, fakeFetch);
  assert.equal(await res.text(), 'net');
  await new Promise((r) => setTimeout(r, 0));
  const cache = await caches.open(PAGES);
  assert.ok(await cache.match(req));
});

test('staleWhileRevalidate: deletes cached entry when network says no-store', async () => {
  const caches = new MockCacheStorage();
  const cache = await caches.open(PAGES);
  const req = new Request('https://x/authed');
  await cache.put(req, new Response('stale-anon'));

  const fakeFetch = (async () =>
    new Response('authed', {
      status: 200,
      headers: { 'cache-control': 'private, no-store' }
    })) as typeof fetch;

  const { staleWhileRevalidate } = await import('../../src/site/sw-core.ts');
  // The stale hit is returned synchronously, then the no-store
  // response evicts the entry on the revalidation tick.
  await staleWhileRevalidate(caches, req, PAGES, PAGES_CAP, fakeFetch);
  await new Promise((r) => setTimeout(r, 0));
  // Either the entry is gone (revalidation pre-empted) or stale
  // (network not yet awaited). Wait one more tick for the chain.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await cache.match(req), undefined);
});

test('staleWhileRevalidate: cached hit survives a network error', async () => {
  const caches = new MockCacheStorage();
  const cache = await caches.open(PAGES);
  const req = new Request('https://x/offline-fallback');
  await cache.put(req, new Response('cached', { status: 200 }));

  const fakeFetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  const { staleWhileRevalidate } = await import('../../src/site/sw-core.ts');
  const res = await staleWhileRevalidate(caches, req, PAGES, PAGES_CAP, fakeFetch);
  assert.equal(await res.text(), 'cached');
});

test('staleWhileRevalidate: cold cache + network error propagates', async () => {
  const caches = new MockCacheStorage();
  const req = new Request('https://x/no-fallback');
  const fakeFetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  const { staleWhileRevalidate } = await import('../../src/site/sw-core.ts');
  await assert.rejects(() => staleWhileRevalidate(caches, req, PAGES, PAGES_CAP, fakeFetch));
});

// ---- dispatchFetch ------------------------------------------------

test('dispatchFetch: non-GET passes through', () => {
  const caches = new MockCacheStorage();
  const req = new Request('https://x/post', { method: 'POST' });
  assert.equal(dispatchFetch(caches, req, 'https://x'), null);
});

test('dispatchFetch: /admin paths pass through', () => {
  const caches = new MockCacheStorage();
  for (const path of ['/admin', '/admin/', '/admin/posts', '/admin/upload']) {
    const req = new Request(`https://x${path}`);
    assert.equal(dispatchFetch(caches, req, 'https://x'), null, `pass-through: ${path}`);
  }
});

test('dispatchFetch: /_debug paths pass through', () => {
  const caches = new MockCacheStorage();
  const req = new Request('https://x/_debug/trace');
  assert.equal(dispatchFetch(caches, req, 'https://x'), null);
});

test('dispatchFetch: cross-origin passes through', () => {
  const caches = new MockCacheStorage();
  const req = new Request('https://other.example.com/asset.js');
  assert.equal(dispatchFetch(caches, req, 'https://x'), null);
});

test('dispatchFetch: /img/* returns a cacheFirst promise', async () => {
  const caches = new MockCacheStorage();
  const req = new Request('https://x/img/abc.def.webp');
  const fakeFetch = (async () => new Response('bytes', { status: 200 })) as typeof fetch;
  const promise = dispatchFetch(caches, req, 'https://x', fakeFetch);
  assert.ok(promise);
  const res = await promise;
  assert.equal(await res.text(), 'bytes');
});

test('dispatchFetch: /static/* and / both return SWR promises', async () => {
  const caches = new MockCacheStorage();
  const fakeFetch = (async (r: Request | string | URL) => {
    const url = typeof r === 'string' ? r : r instanceof URL ? r.toString() : r.url;
    return new Response(`net:${url}`, { status: 200 });
  }) as typeof fetch;

  const a = await dispatchFetch(
    caches,
    new Request('https://x/static/base.css'),
    'https://x',
    fakeFetch
  );
  assert.ok(a);
  assert.match(await a.text(), /net:.*\/static\/base\.css/);

  const b = await dispatchFetch(caches, new Request('https://x/'), 'https://x', fakeFetch);
  assert.ok(b);
  assert.match(await b.text(), /net:.*\/$/);

  const c = await dispatchFetch(caches, new Request('https://x/some-slug'), 'https://x', fakeFetch);
  assert.ok(c);
});

// ---- runInstall / runActivate / runMessage ------------------------

test('runInstall: pre-fills the shell cache with the SHELL_PRECACHE list', async () => {
  const caches = new MockCacheStorage();
  await runInstall(caches);
  const cache = await caches.open(SHELL);
  const keys = await cache.keys();
  assert.equal(keys.length, SHELL_PRECACHE.length);
  for (const path of SHELL_PRECACHE) {
    const ok = keys.some((k) => k.url.endsWith(path));
    assert.ok(ok, `precache missing entry for ${path}`);
  }
});

test('runActivate: deletes legacy rkr-* caches, keeps current versions', async () => {
  const caches = new MockCacheStorage();
  await caches.open('rkr-shell-v1'); // legacy
  await caches.open('rkr-pages-v2'); // legacy
  await caches.open(SHELL); // current
  await caches.open(IMAGES); // current
  await caches.open('other-app-cache'); // not ours — leave alone.

  await runActivate(caches);
  const remaining = await caches.keys();
  assert.deepEqual(
    [...remaining].sort(),
    [...ALL_CACHES.filter((n) => n === SHELL || n === IMAGES), 'other-app-cache'].sort()
  );
});

test('runMessage: rkr-pages-flush wipes the PAGES cache', async () => {
  const caches = new MockCacheStorage();
  const cache = await caches.open(PAGES);
  await cache.put(new Request('https://x/stale'), new Response('stale'));
  assert.ok(await caches.has(PAGES));

  const task = runMessage(caches, { type: 'rkr-pages-flush' });
  assert.ok(task);
  await task;
  assert.equal(await caches.has(PAGES), false);
});

test('runMessage: unrelated messages return null without touching caches', async () => {
  const caches = new MockCacheStorage();
  assert.equal(runMessage(caches, { type: 'something-else' }), null);
  assert.equal(runMessage(caches, null), null);
  assert.equal(runMessage(caches, undefined), null);
  assert.equal(runMessage(caches, 'not-an-object'), null);
});
