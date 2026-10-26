import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { runReindex } from '../../src/lib/post-index.ts';
import { buildApp } from '../../src/server.ts';

const HERO = {
  defaults: { heading: 'Fresh food' },
  tree: {
    type: 'section',
    slots: { theme: 'dark', edge: 'wave' },
    children: [{ type: 'text', markdown: '# Fresh food\n\nJoin us.' }]
  }
};

const TOKEN = 'test-blocks-routes-token';

async function setup(t: TestContext, opts: { gated?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-blocks-routes-'));
  fs.mkdirSync(path.join(root, 'macros'), { recursive: true });
  fs.mkdirSync(path.join(root, 'content', 'blocks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'macros', 'hero.json'), JSON.stringify(HERO));
  fs.writeFileSync(
    path.join(root, 'macros', 'wrap.json'),
    JSON.stringify({
      defaults: {},
      tree: { type: 'section', children: [{ type: 'macro', macro: 'hero' }] }
    })
  );
  const page = (file: string, fields: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(root, 'content', 'blocks', file),
      JSON.stringify({
        version: 1,
        body: [{ type: 'flow', blocks: [{ type: 'text', markdown: 'Secret words.' }] }],
        fields
      })
    );
  page('hello.json', { title: 'Hello page', slug: 'hello', status: 'published' });
  page('plans.json', { title: 'Secret plans', slug: 'plans', status: 'draft' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());

  const prevToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = TOKEN;
  t.after(() => {
    if (prevToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prevToken;
  });
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    ...(opts.gated
      ? {
          auth: {
            exchange: {
              authorizationUrl: () => new URL('https://example.com/'),
              exchange: async () => {
                throw new Error('not used');
              }
            },
            secureCookies: false
          }
        }
      : {})
  });
  t.after(async () => {
    await app.close();
    events.removeAllListeners('enqueued');
  });
  return { app, root };
}

describe('blocks routes', () => {
  it('GET /pages/:slug redirects a published page to /:slug', async (t) => {
    const { app } = await setup(t);
    const res = await app.inject({ method: 'GET', url: '/pages/hello' });
    assert.equal(res.statusCode, 301);
    assert.equal(res.headers.location, '/hello');
  });

  it('an anonymous reader never sees a draft page', async (t) => {
    const { app, root } = await setup(t, { gated: true });
    runReindex(root);
    for (const url of ['/pages/plans', '/plans']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 404, url);
      assert.doesNotMatch(res.body, /Secret/, url);
    }
    for (const url of ['/', '/search?q=secret']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, url);
      assert.doesNotMatch(res.body, /Secret plans|\/plans/, url);
    }
  });

  it('GET /pages/:slug 404s missing pages and bad slugs', async (t) => {
    const { app } = await setup(t);
    assert.equal((await app.inject({ method: 'GET', url: '/pages/nope' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/pages/NOPE' })).statusCode, 404);
  });

  it('there is no public page list or macro render', async (t) => {
    const { app } = await setup(t, { gated: true });
    for (const url of ['/pages', '/blocks/hero']) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 404, url);
      assert.doesNotMatch(res.body, /Secret plans|plans/, url);
      assert.doesNotMatch(res.body, /Fresh food/, url);
    }
  });

  it('GET /admin/blocks/preview/:macro requires a signed-in editor', async (t) => {
    const { app } = await setup(t, { gated: true });
    const anon = await app.inject({ method: 'GET', url: '/admin/blocks/preview/hero' });
    assert.equal(anon.statusCode, 401);
    assert.doesNotMatch(anon.body, /Fresh food/);
    const authed = await app.inject({
      method: 'GET',
      url: '/admin/blocks/preview/hero',
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(authed.statusCode, 200);
    assert.match(authed.body, /Fresh food/);
    assert.match(authed.body, /rkr-section-wave/);
  });

  it('GET /admin/blocks/preview/:macro expands nested macros', async (t) => {
    const { app } = await setup(t);
    const res = await app.inject({ method: 'GET', url: '/admin/blocks/preview/wrap' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Fresh food/);
  });

  it('GET /admin/blocks/preview/:macro 404s unknown macros and bad names', async (t) => {
    const { app } = await setup(t);
    const bad = await app.inject({ method: 'GET', url: '/admin/blocks/preview/BAD' });
    assert.equal(bad.statusCode, 404);
    const missing = await app.inject({ method: 'GET', url: '/admin/blocks/preview/nope' });
    assert.equal(missing.statusCode, 404);
  });
});
