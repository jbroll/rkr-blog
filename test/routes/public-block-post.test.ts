// GET /:slug for a JSON page: fields and banner placement match what the
// markdown path rendered for the same post.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { runReindex } from '../../src/lib/post-index.ts';
import { buildApp } from '../../src/server.ts';

async function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-block-post-'));
  for (const sub of ['content/posts', 'content/blocks', 'data', 'macros']) {
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
  const page = (slug: string, body: unknown[], fields: Record<string, unknown> = {}) => {
    fs.writeFileSync(
      path.join(root, 'content', 'blocks', `${slug}.json`),
      JSON.stringify({
        version: 1,
        body,
        fields: { title: `Title ${slug}`, slug, status: 'published', ...fields }
      })
    );
    runReindex(root);
  };
  return { root, app, page };
}

test('a JSON page renders fields.subtitle under the title', async (t) => {
  const { app, page } = await setup(t);
  page('sub', [{ type: 'text', markdown: 'Body.' }], { subtitle: 'A smaller <heading>' });
  const res = await app.inject({ method: 'GET', url: '/sub' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<p class="rkr-post-subtitle">A smaller &lt;heading&gt;<\/p>/);
});
