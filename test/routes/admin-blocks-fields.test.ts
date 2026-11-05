import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { buildApp } from '../../src/server.ts';

async function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-blocks-fields-'));
  for (const sub of ['macros', 'content/blocks', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(async () => {
    await app.close();
    events.removeAllListeners('enqueued');
  });
  const save = (extra: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/admin/blocks/p',
      payload: {
        tree: { version: 1, body: [], fields: { title: 'P', slug: 'p', ...extra } }
      }
    });
  return { save };
}

test('save refuses a fractional order', async (t) => {
  const { save } = await setup(t);
  const res = await save({ order: 1.5 });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /order/);
});

test('save refuses a string order', async (t) => {
  const { save } = await setup(t);
  assert.equal((await save({ order: '3' })).statusCode, 400);
});

test('save accepts an integer order and an absent one', async (t) => {
  const { save } = await setup(t);
  assert.equal((await save({ order: 3 })).statusCode, 200);
  assert.equal((await save({})).statusCode, 200);
});
