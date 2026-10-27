import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ADMIN_CACHE_PREFIX } from '../../src/site/admin-caches.ts';
import {
  CACHE_PREFIX,
  evictOldCaches,
  handleFetch,
  PRECACHE_URL,
  precacheInstall,
  refreshCachedPage
} from '../../src/site/sw-admin-core.ts';

class FakeCache {
  entries = new Map<string, Response>();
  async addAll(urls: string[]): Promise<void> {
    for (const u of urls) this.entries.set(u, new Response(`body:${u}`));
  }
  async add(url: string): Promise<void> {
    this.entries.set(url, new Response(`body:${url}`));
  }
  async put(req: Request | string, res: Response): Promise<void> {
    this.entries.set(typeof req === 'string' ? req : req.url, res);
  }
  async match(
    req: Request | string,
    opts?: { ignoreSearch?: boolean }
  ): Promise<Response | undefined> {
    const url = new URL(typeof req === 'string' ? req : req.url, 'https://x.test');
    for (const [k, v] of this.entries) {
      const kk = new URL(k, 'https://x.test');
      if (kk.pathname !== url.pathname) continue;
      if (opts?.ignoreSearch || kk.search === url.search) return v.clone();
    }
    return undefined;
  }
}

class FakeCaches {
  store = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    let c = this.store.get(name);
    if (!c) {
      c = new FakeCache();
      this.store.set(name, c);
    }
    return c;
  }
  async keys(): Promise<string[]> {
    return [...this.store.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.store.delete(name);
  }
  async match(
    req: Request | string,
    opts?: { ignoreSearch?: boolean }
  ): Promise<Response | undefined> {
    for (const c of this.store.values()) {
      const hit = await c.match(req, opts);
      if (hit) return hit;
    }
    return undefined;
  }
}

const PRECACHE = {
  hash: 'abcdef012345',
  assets: [
    '/admin/static/admin/blocks-page-editor-entry.js?v=abcdef012345',
    '/admin/static/base.css?v=abcdef012345'
  ]
};

type Env = Parameters<typeof precacheInstall>[0];

function env(fetchImpl: typeof fetch): Env {
  return { caches: new FakeCaches(), fetch: fetchImpl } as never as Env;
}

// The Fetch spec forbids constructing a Request with mode: 'navigate'
// directly (it only ever arrives that way on a real fetch event), so
// fake it by overriding the getter on an ordinary Request.
function navRequest(url: string): Request {
  const req = new Request(url);
  Object.defineProperty(req, 'mode', { value: 'navigate' });
  return req;
}

const okPrecache: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith(PRECACHE_URL)) return new Response(JSON.stringify(PRECACHE));
  return new Response(`network:${url}`);
};

const offline = (e: Env): Env => ({
  ...e,
  fetch: (async () => {
    throw new Error('offline');
  }) as typeof fetch
});

test('precacheInstall: caches every listed asset under rkr-admin-<hash>', async () => {
  const requested: string[] = [];
  const e = env(async (input, init) => {
    requested.push(String(input instanceof Request ? input.url : input));
    return okPrecache(input, init);
  });
  const hash = await precacheInstall(e);
  assert.equal(hash, 'abcdef012345');
  const cache = await e.caches.open(`${CACHE_PREFIX}abcdef012345`);
  assert.ok(await cache.match('/admin/static/admin/blocks-page-editor-entry.js?v=abcdef012345'));
  assert.deepEqual(requested, [PRECACHE_URL], 'no retired shell is fetched at install');
});

test('evictOldCaches: deletes foreign hashes, keeps the current one', async () => {
  const e = env(okPrecache);
  await e.caches.open(`${CACHE_PREFIX}old111111111`);
  await e.caches.open(`${CACHE_PREFIX}abcdef012345`);
  await e.caches.open('some-other-cache');
  const deleted = await evictOldCaches(e, 'abcdef012345');
  assert.deepEqual(deleted, [`${CACHE_PREFIX}old111111111`]);
  assert.deepEqual((await e.caches.keys()).sort(), [
    `${CACHE_PREFIX}abcdef012345`,
    'some-other-cache'
  ]);
});

test('editor navigation: prefers the network and caches the render under its path', async () => {
  const e = env(okPrecache);
  await precacheInstall(e);
  const res = await handleFetch(e, navRequest('https://x.test/admin/blocks/edit/hello'));
  assert.equal(await (res as Response).text(), 'network:https://x.test/admin/blocks/edit/hello');
  const cache = await e.caches.open(`${CACHE_PREFIX}abcdef012345`);
  const hit = await cache.match('https://x.test/admin/blocks/edit/hello');
  assert.ok(hit, 'render cached');
  assert.equal(await (hit as Response).text(), 'network:https://x.test/admin/blocks/edit/hello');
});

test('editor navigation: caches _footer but not other _ slugs', async () => {
  const e = env(okPrecache);
  await precacheInstall(e);
  await handleFetch(e, navRequest('https://x.test/admin/blocks/edit/_footer'));
  await handleFetch(e, navRequest('https://x.test/admin/blocks/edit/_other'));
  const cache = await e.caches.open(`${CACHE_PREFIX}abcdef012345`);
  assert.ok(await cache.match('https://x.test/admin/blocks/edit/_footer'));
  assert.equal(await cache.match('https://x.test/admin/blocks/edit/_other'), undefined);
});

test('editor navigation: offline serves the last render of the same page', async () => {
  const e = env(okPrecache);
  await precacheInstall(e);
  await handleFetch(e, navRequest('https://x.test/admin/blocks/edit/hello'));
  await handleFetch(e, navRequest('https://x.test/admin/blocks/edit/other'));
  const res = await handleFetch(offline(e), navRequest('https://x.test/admin/blocks/edit/hello'));
  assert.equal(await (res as Response).text(), 'network:https://x.test/admin/blocks/edit/hello');
});

test('editor navigation: offline, a query-string request falls back to the path copy', async () => {
  const e = env(okPrecache);
  await precacheInstall(e);
  await handleFetch(e, navRequest('https://x.test/admin/blocks/edit/hello'));
  const res = await handleFetch(
    offline(e),
    navRequest('https://x.test/admin/blocks/edit/hello?e2e=1')
  );
  assert.equal(await (res as Response).text(), 'network:https://x.test/admin/blocks/edit/hello');
});

test('editor navigation: offline, a page never opened yields 503, not a throw', async () => {
  const e = env(okPrecache);
  await precacheInstall(e);
  await handleFetch(e, navRequest('https://x.test/admin/blocks/edit/hello'));
  const res = await handleFetch(offline(e), navRequest('https://x.test/admin/blocks/edit/nope'));
  assert.equal((res as Response).status, 503);
});

test('pages list navigation: network-first with a cached fallback', async () => {
  const e = env(okPrecache);
  await precacheInstall(e);
  await handleFetch(e, navRequest('https://x.test/admin/blocks'));
  const res = await handleFetch(offline(e), navRequest('https://x.test/admin/blocks'));
  assert.equal(await (res as Response).text(), 'network:https://x.test/admin/blocks');
});

test('pages list: a filtered render never replaces the cached full list', async () => {
  const e = env(okPrecache);
  await precacheInstall(e);
  await handleFetch(e, navRequest('https://x.test/admin/blocks'));
  const filtered = await handleFetch(e, navRequest('https://x.test/admin/blocks?q=trip'));
  assert.equal(await (filtered as Response).text(), 'network:https://x.test/admin/blocks?q=trip');
  const res = await handleFetch(offline(e), navRequest('https://x.test/admin/blocks'));
  assert.equal(await (res as Response).text(), 'network:https://x.test/admin/blocks');
});

test('macro list: network-first with a cached fallback, whatever the request mode', async () => {
  const e = env(okPrecache);
  await precacheInstall(e);
  await handleFetch(e, new Request('https://x.test/admin/blocks/macros'));
  const res = await handleFetch(offline(e), new Request('https://x.test/admin/blocks/macros'));
  assert.equal(await (res as Response).text(), 'network:https://x.test/admin/blocks/macros');
});

test('site theme: network-first, cached despite the ?v= query, served offline', async () => {
  const e = env(okPrecache);
  await precacheInstall(e);
  const url = 'https://x.test/admin/site-theme/club.css?v=abc';
  await handleFetch(e, new Request(url));
  const res = await handleFetch(offline(e), new Request(url));
  assert.equal(await (res as Response).text(), `network:${url}`);
});

test('refreshCachedPage: replaces the cached render of a saved editor page', async () => {
  let n = 0;
  const e = env(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith(PRECACHE_URL)) return okPrecache(input, init);
    n++;
    return new Response(`render ${n}`);
  });
  await precacheInstall(e);
  await handleFetch(e, navRequest('https://x.test/admin/blocks/edit/hello'));
  await refreshCachedPage(e, 'https://x.test', '/admin/blocks/edit/hello');
  const res = await handleFetch(offline(e), navRequest('https://x.test/admin/blocks/edit/hello'));
  assert.equal(await (res as Response).text(), 'render 2');
});

test('refreshCachedPage: ignores anything but an editor page path', async () => {
  const calls: string[] = [];
  const e = env(async (input, init) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return okPrecache(input, init);
  });
  await refreshCachedPage(e, 'https://x.test', '/admin/sync/drain');
  await refreshCachedPage(e, 'https://x.test', '/admin/blocks/edit/../../logout');
  await refreshCachedPage(e, 'https://x.test', 42 as unknown as string);
  assert.deepEqual(calls, []);
});

test('refreshCachedPage: offline is a no-op, not a throw', async () => {
  const e = env(okPrecache);
  await precacheInstall(e);
  await refreshCachedPage(offline(e), 'https://x.test', '/admin/blocks/edit/hello');
});

test('retired shell paths are not intercepted', () => {
  const e = env(okPrecache);
  assert.equal(handleFetch(e, navRequest('https://x.test/admin/view/hello')), null);
  assert.equal(handleFetch(e, navRequest('https://x.test/admin/editor')), null);
  assert.equal(handleFetch(e, navRequest('https://x.test/admin/blocks/new')), null);
});

test('editor navigation: a non-2xx render is not cached', async () => {
  const unauthorized = env(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith(PRECACHE_URL)) return new Response(JSON.stringify(PRECACHE));
    return new Response('unauthorized', { status: 401 });
  });
  await precacheInstall(unauthorized);
  const res = await handleFetch(unauthorized, navRequest('https://x.test/admin/blocks/edit/a'));
  assert.equal((res as Response).status, 401);
  const cache = await unauthorized.caches.open(`${CACHE_PREFIX}abcdef012345`);
  assert.equal(await cache.match('https://x.test/admin/blocks/edit/a'), undefined);
});

test('editor navigation: caching is skipped when no rkr-admin cache exists', async () => {
  const e = env(okPrecache);
  const res = await handleFetch(e, navRequest('https://x.test/admin/blocks/edit/a'));
  assert.equal(await (res as Response).text(), 'network:https://x.test/admin/blocks/edit/a');
  assert.deepEqual(await e.caches.keys(), []);
});

test('/admin/static/*: served from cache with no network call on a hit', async () => {
  const e = env(okPrecache);
  await precacheInstall(e);
  let calls = 0;
  const counting = {
    ...e,
    fetch: (async (...args: Parameters<typeof fetch>) => {
      calls++;
      return okPrecache(...args);
    }) as typeof fetch
  };
  const res = await handleFetch(
    counting,
    new Request('https://x.test/admin/static/base.css?v=abcdef012345')
  );
  assert.equal(await (res as Response).text(), 'body:/admin/static/base.css?v=abcdef012345');
  assert.equal(calls, 0);
});

test('/admin/api/* is not intercepted', () => {
  const e = env(okPrecache);
  assert.equal(handleFetch(e, new Request('https://x.test/admin/sync/drain')), null);
  assert.equal(handleFetch(e, new Request('https://x.test/admin/post-bundle/x?manifest=1')), null);
  assert.equal(handleFetch(e, new Request('https://x.test/admin/blocks/hello')), null);
});

test('/admin/static/*: a cache miss falls through to the network', async () => {
  const e = env(okPrecache);
  const res = await handleFetch(e, new Request('https://x.test/admin/static/nope.css'));
  assert.equal(await (res as Response).text(), 'network:https://x.test/admin/static/nope.css');
});

test('a POST under /admin/ is never intercepted', () => {
  const e = env(okPrecache);
  assert.equal(
    handleFetch(e, new Request('https://x.test/admin/static/base.css', { method: 'POST' })),
    null
  );
  assert.equal(
    handleFetch(e, new Request('https://x.test/admin/blocks/edit/a', { method: 'POST' })),
    null
  );
});

test('sign-out and the admin worker agree on the cache prefix', () => {
  assert.equal(ADMIN_CACHE_PREFIX, CACHE_PREFIX);
});
