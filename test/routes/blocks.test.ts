import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { buildApp } from '../../src/server.ts';

const HERO = {
  defaults: { heading: 'Fresh food' },
  tree: {
    type: 'section',
    slots: { theme: 'dark', edge: 'wave' },
    children: [{ type: 'text', markdown: '# Fresh food\n\nJoin us.' }]
  }
};

async function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-blocks-routes-'));
  fs.mkdirSync(path.join(root, 'macros'), { recursive: true });
  fs.mkdirSync(path.join(root, 'content', 'blocks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'macros', 'hero.json'), JSON.stringify(HERO));
  fs.writeFileSync(
    path.join(root, 'content', 'blocks', 'hello.json'),
    JSON.stringify({
      version: 1,
      body: [{ type: 'flow', blocks: [{ type: 'text', markdown: 'Hello page.' }] }],
      fields: { title: 'Hello page', slug: 'hello' }
    })
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());

  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(async () => {
    await app.close();
    events.removeAllListeners('enqueued');
  });
  return { app };
}

describe('blocks routes', () => {
  it('GET /blocks/:macro renders the macro in site chrome', async (t) => {
    const { app } = await setup(t);
    const res = await app.inject({ method: 'GET', url: '/blocks/hero' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /text\/html/);
    assert.match(res.body, /Fresh food/);
    assert.match(res.body, /rkr-site-head/);
    assert.match(res.body, /rkr-section-wave/);
  });

  it('GET /blocks/:macro 404s unknown macros and bad names', async (t) => {
    const { app } = await setup(t);
    assert.equal((await app.inject({ method: 'GET', url: '/blocks/nope' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/blocks/BAD' })).statusCode, 404);
  });

  it('GET /admin/blocks/preview/:macro renders for editors', async (t) => {
    const { app } = await setup(t);
    const res = await app.inject({ method: 'GET', url: '/admin/blocks/preview/hero' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Fresh food/);
  });

  it('GET /pages/:slug renders a stored JSON page', async (t) => {
    const { app } = await setup(t);
    const res = await app.inject({ method: 'GET', url: '/pages/hello' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Hello page/);
    assert.match(res.body, /rkr-flow/);
  });

  it('GET /pages/:slug 404s missing pages and bad slugs', async (t) => {
    const { app } = await setup(t);
    assert.equal((await app.inject({ method: 'GET', url: '/pages/nope' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/pages/NOPE' })).statusCode, 404);
  });

  it('GET /pages lists stored pages', async (t) => {
    const { app } = await setup(t);
    const res = await app.inject({ method: 'GET', url: '/pages' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /\/pages\/hello/);
    assert.match(res.body, /Hello page/);
  });
});
