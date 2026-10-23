import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { buildApp } from '../../src/server.ts';

const TREE = {
  version: 1,
  body: [{ type: 'flow', blocks: [{ type: 'text', markdown: 'Saved.' }] }],
  fields: { title: 'Saved page', slug: 'saved' }
};

async function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-admin-blocks-'));
  fs.mkdirSync(path.join(root, 'macros'), { recursive: true });
  fs.mkdirSync(path.join(root, 'content', 'blocks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());

  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(async () => {
    await app.close();
    events.removeAllListeners('enqueued');
  });
  return { root, app };
}

describe('admin blocks save', () => {
  it('POST /admin/blocks/:slug writes a validated JSON page', async (t) => {
    const { root, app } = await setup(t);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/blocks/saved',
      payload: { tree: TREE }
    });
    assert.equal(res.statusCode, 200);
    const saved = JSON.parse(
      fs.readFileSync(path.join(root, 'content', 'blocks', 'saved.json'), 'utf8')
    ) as { fields: { slug: string } };
    assert.equal(saved.fields.slug, 'saved');
  });

  it('GET /admin/blocks/macros lists the palette entries', async (t) => {
    const { root, app } = await setup(t);
    fs.writeFileSync(
      path.join(root, 'macros', 'hero.json'),
      JSON.stringify({ defaults: {}, tree: { type: 'text', markdown: 'Hi' } })
    );
    const res = await app.inject({ method: 'GET', url: '/admin/blocks/macros' });
    assert.equal(res.statusCode, 200);
    const list = JSON.parse(res.body) as { name: string; label: string }[];
    assert.ok(list.some((m) => m.name === 'hero' && typeof m.label === 'string'));
  });

  it('rejects invalid trees and bad slugs', async (t) => {
    const { app } = await setup(t);
    const bad = await app.inject({
      method: 'POST',
      url: '/admin/blocks/saved',
      payload: { tree: { version: 1, body: [{ type: 'nope' }] } }
    });
    assert.equal(bad.statusCode, 400);
    const slug = await app.inject({
      method: 'POST',
      url: '/admin/blocks/BAD',
      payload: { tree: TREE }
    });
    assert.equal(slug.statusCode, 404);
  });

  it('GET /admin/blocks/:slug returns the stored tree as JSON', async (t) => {
    const { root, app } = await setup(t);
    fs.writeFileSync(
      path.join(root, 'content', 'blocks', 'saved.json'),
      JSON.stringify({
        version: 1,
        body: [{ type: 'text', markdown: 'Hi' }],
        fields: { title: 'Saved', slug: 'saved' }
      })
    );
    const res = await app.inject({ method: 'GET', url: '/admin/blocks/saved' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { tree: { version: number }; title: string };
    assert.equal(body.tree.version, 1);
    assert.equal(body.title, 'Saved');
    assert.equal((await app.inject({ method: 'GET', url: '/admin/blocks/nope' })).statusCode, 404);
  });

  it('GET /admin/blocks lists pages with view and edit links', async (t) => {
    const { root, app } = await setup(t);
    fs.writeFileSync(
      path.join(root, 'content', 'blocks', 'saved.json'),
      JSON.stringify({
        version: 1,
        body: [{ type: 'text', markdown: 'Hi' }],
        fields: { title: 'Saved', slug: 'saved' }
      })
    );
    const res = await app.inject({ method: 'GET', url: '/admin/blocks' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /\/pages\/saved/);
    assert.match(res.body, /\/admin\/blocks\/edit\/saved/);
    assert.match(res.body, /\/admin\/blocks\/new/);
  });

  it('GET /admin/blocks/edit/:slug serves the editor shell', async (t) => {
    const { root, app } = await setup(t);
    fs.writeFileSync(
      path.join(root, 'content', 'blocks', 'saved.json'),
      JSON.stringify({
        version: 1,
        body: [{ type: 'text', markdown: 'Hi' }],
        fields: { title: 'Saved', slug: 'saved' }
      })
    );
    const res = await app.inject({ method: 'GET', url: '/admin/blocks/edit/saved' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /rkr-blocks-edit-root/);
    assert.match(res.body, /blocks-page-editor-entry/);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/admin/blocks/edit/nope' })).statusCode,
      404
    );
  });

  it('GET /admin/blocks/new renders the new-page form', async (t) => {
    const { app } = await setup(t);
    const res = await app.inject({ method: 'GET', url: '/admin/blocks/new' });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /name="slug"/);
  });

  it('POST /admin/blocks/new creates an empty page and redirects to edit', async (t) => {
    const { root, app } = await setup(t);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/blocks/new',
      payload: { slug: 'fresh-page' }
    });
    assert.equal(res.statusCode, 303);
    assert.equal(res.headers.location, '/admin/blocks/edit/fresh-page');
    assert.ok(fs.existsSync(path.join(root, 'content', 'blocks', 'fresh-page.json')));
    const bad = await app.inject({
      method: 'POST',
      url: '/admin/blocks/new',
      payload: { slug: 'BAD' }
    });
    assert.equal(bad.statusCode, 404);
  });
});
