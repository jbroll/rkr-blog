import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CACHE_PREFIX,
  evictOldCaches,
  handleFetch,
  PRECACHE_URL,
  precacheInstall,
  SHELL_URL
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
      if (opts?.ignoreSearch || kk.search === url.search) return v;
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
  assets: ['/admin/static/admin/main.js?v=abcdef012345', '/admin/static/base.css?v=abcdef012345']
};

function env(fetchImpl: typeof fetch): { caches: FakeCaches; fetch: typeof fetch } {
  return { caches: new FakeCaches(), fetch: fetchImpl };
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

test('precacheInstall: caches every listed asset plus the shell, under rkr-admin-<hash>', async () => {
  const e = env(okPrecache) as never as Parameters<typeof precacheInstall>[0];
  const hash = await precacheInstall(e);
  assert.equal(hash, 'abcdef012345');
  const cache = await e.caches.open(`${CACHE_PREFIX}abcdef012345`);
  assert.ok(await cache.match('/admin/static/admin/main.js?v=abcdef012345'));
  assert.ok(await cache.match(SHELL_URL));
});

test('evictOldCaches: deletes foreign hashes, keeps the current one', async () => {
  const e = env(okPrecache) as never as Parameters<typeof evictOldCaches>[0];
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

test('navigation: prefers the network when fetch resolves', async () => {
  const e = env(okPrecache) as never as Parameters<typeof precacheInstall>[0];
  await precacheInstall(e);
  const res = await handleFetch(e, navRequest('https://x.test/admin/editor'));
  assert.equal(await (res as Response).text(), 'network:https://x.test/admin/editor');
});

test('navigation: falls back to the cached shell when fetch rejects', async () => {
  const e = env(okPrecache) as never as Parameters<typeof precacheInstall>[0];
  await precacheInstall(e);
  const offline = {
    ...e,
    fetch: (async () => {
      throw new Error('offline');
    }) as typeof fetch
  };
  const res = await handleFetch(offline, navRequest('https://x.test/admin/editor?slug=a'));
  assert.equal(await (res as Response).text(), 'body:/admin/editor');
});

test('navigation: /admin/view/<slug> falls back to the same cached shell', async () => {
  const e = env(okPrecache) as never as Parameters<typeof precacheInstall>[0];
  await precacheInstall(e);
  const offline = {
    ...e,
    fetch: (async () => {
      throw new Error('offline');
    }) as typeof fetch
  };
  const res = await handleFetch(offline, navRequest('https://x.test/admin/view/hello'));
  assert.equal(await (res as Response).text(), 'body:/admin/editor');
});

test('/admin/static/*: served from cache with no network call on a hit', async () => {
  const e = env(okPrecache) as never as Parameters<typeof precacheInstall>[0];
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
  const e = env(okPrecache) as never as Parameters<typeof precacheInstall>[0];
  assert.equal(handleFetch(e, new Request('https://x.test/admin/sync/drain')), null);
  assert.equal(handleFetch(e, new Request('https://x.test/admin/post-bundle/x?manifest=1')), null);
});

test('/admin/static/*: a cache miss falls through to the network', async () => {
  const e = env(okPrecache) as never as Parameters<typeof precacheInstall>[0];
  const res = await handleFetch(e, new Request('https://x.test/admin/static/nope.css'));
  assert.equal(await (res as Response).text(), 'network:https://x.test/admin/static/nope.css');
});

test('navigation: offline with nothing cached yields 503, not a throw', async () => {
  const offline = {
    ...(env(okPrecache) as never as Parameters<typeof precacheInstall>[0]),
    fetch: (async () => {
      throw new Error('offline');
    }) as typeof fetch
  };
  const res = await handleFetch(offline, navRequest('https://x.test/admin/editor'));
  assert.equal((res as Response).status, 503);
});

test('a POST under /admin/ is never intercepted', () => {
  const e = env(okPrecache) as never as Parameters<typeof precacheInstall>[0];
  assert.equal(
    handleFetch(e, new Request('https://x.test/admin/static/base.css', { method: 'POST' })),
    null
  );
});
