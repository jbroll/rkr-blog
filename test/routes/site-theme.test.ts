import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { buildApp } from '../../src/server.ts';

async function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-site-theme-'));
  fs.mkdirSync(path.join(root, 'themes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'themes', 'club.css'), 'body{color:red}');
  fs.writeFileSync(path.join(root, 'themes', 'default.css'), 'body{}');
  fs.writeFileSync(path.join(root, 'themes', 'x.js'), 'alert(1)');
  fs.writeFileSync(path.join(root, 'themes', 'Up.css'), 'a{}');
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(() => app.close());
  return app;
}

for (const prefix of ['/site-theme', '/admin/site-theme']) {
  test(`GET ${prefix}/club.css serves the stylesheet`, async (t) => {
    const app = await setup(t);
    const res = await app.inject({ method: 'GET', url: `${prefix}/club.css` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.body, 'body{color:red}');
  });

  test(`GET ${prefix}: bad names and missing files are 404`, async (t) => {
    const app = await setup(t);
    for (const f of [
      '..%2Fx.css',
      'X.css',
      'Up.css',
      'x.js',
      'club.CSS',
      'missing.css',
      'default.css'
    ]) {
      const res = await app.inject({ method: 'GET', url: `${prefix}/${f}` });
      assert.equal(res.statusCode, 404, f);
    }
  });
}
