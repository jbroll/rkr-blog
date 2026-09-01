// The service-worker entry (src/site/sw-admin.ts) registers its listeners at
// import time against the global `self`, so the fake has to be installed
// before the dynamic import below. One import per process: node caches ESM.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { CACHE_PREFIX } from '../../src/site/sw-admin-core.ts';

type Listener = (event: FakeEvent) => void;

interface FakeEvent {
  request?: Request;
  waitUntil(p: Promise<unknown>): void;
  respondWith(p: Promise<Response>): void;
}

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
  async match(): Promise<Response | undefined> {
    return undefined;
  }
}

const listeners = new Map<string, Listener>();
const caches = new Map<string, FakeCache>();
const calls: string[] = [];

const fire = async (type: string, event: Partial<FakeEvent> = {}): Promise<unknown> => {
  const settled: Promise<unknown>[] = [];
  const listener = listeners.get(type);
  assert.ok(listener, `no listener registered for ${type}`);
  listener({
    ...event,
    waitUntil: (p) => settled.push(p),
    respondWith: (p) => settled.push(p)
  } as FakeEvent);
  const [first] = await Promise.all(settled);
  return first;
};

before(async () => {
  const self = {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: () => calls.push('skipWaiting'),
    clients: { claim: () => calls.push('claim') },
    fetch: async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('precache.json')) {
        return Response.json({ hash: 'abc123', assets: ['/admin/static/admin/main.js'] });
      }
      return new Response('shell', { status: 200 });
    },
    caches: {
      open: async (name: string) => {
        const existing = caches.get(name);
        if (existing) return existing;
        const created = new FakeCache();
        caches.set(name, created);
        return created;
      },
      keys: async () => [...caches.keys()],
      delete: async (name: string) => caches.delete(name)
    }
  };
  (globalThis as unknown as { self: unknown }).self = self;
  await import('../../src/site/sw-admin.ts');
});

describe('service worker entry', () => {
  it('precaches the manifest and takes over on install', async () => {
    await fire('install');
    const cache = caches.get(`${CACHE_PREFIX}abc123`);
    assert.ok(cache, 'install did not open the build-hash cache');
    assert.ok(cache.entries.has('/admin/static/admin/main.js'));
    assert.ok(cache.entries.has('/admin/editor'), 'shell not cached');
    assert.ok(calls.includes('skipWaiting'));
  });

  it('evicts caches from other builds and claims clients on activate', async () => {
    caches.set(`${CACHE_PREFIX}stale`, new FakeCache());
    await fire('activate');
    assert.deepEqual(
      [...caches.keys()].filter((n) => n.startsWith(CACHE_PREFIX)),
      [`${CACHE_PREFIX}abc123`]
    );
    assert.ok(calls.includes('claim'));
  });

  it('answers a shell navigation from the fetch handler', async () => {
    // The Fetch spec forbids constructing a Request with mode 'navigate';
    // it only ever arrives that way on a real fetch event.
    const request = new Request('https://x.test/admin/editor');
    Object.defineProperty(request, 'mode', { value: 'navigate' });
    const res = (await fire('fetch', { request })) as Response;
    assert.equal(await res.text(), 'shell');
  });

  it('leaves a request the handler declines to the network', async () => {
    const request = new Request('https://x.test/admin/posts', { method: 'POST' });
    let respondWith = false;
    listeners.get('fetch')?.({
      request,
      waitUntil: () => {},
      respondWith: () => {
        respondWith = true;
      }
    } as FakeEvent);
    assert.equal(respondWith, false);
  });
});
