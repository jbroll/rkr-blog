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
});
