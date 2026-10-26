// GET /:slug for a JSON page: fields and banner placement match what the
// markdown path rendered for the same post.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { ingestStream } from '../../src/lib/originals.ts';
import { runReindex } from '../../src/lib/post-index.ts';
import { buildApp } from '../../src/server.ts';

async function ingestImage(root: string): Promise<string> {
  const jpeg = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  const r = await ingestStream({
    stream: Readable.from([jpeg]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'hero.jpg' }
  });
  return r.id;
}

async function setup(t: TestContext, site: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-block-post-'));
  for (const sub of ['content/posts', 'content/blocks', 'data', 'macros']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  t.after(() => db.close());
  const app = await buildApp({
    siteRoot: root,
    db,
    startWorker: false,
    site: { title: 'Block Site', ...site }
  });
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

/** Index of the banner figure relative to the page landmarks. */
function placement(html: string): { figure: number; head: number; main: number } {
  return {
    figure: html.indexOf('rkr-justify-bleed'),
    head: html.indexOf('rkr-site-head'),
    main: html.indexOf('<main')
  };
}

test('a leading bleed figure inside the first flow renders in the banner slot', async (t) => {
  const { root, app, page } = await setup(t);
  const id = await ingestImage(root);
  page('trip', [
    {
      type: 'flow',
      blocks: [
        { type: 'figure', slots: { ids: id, justify: 'bleed' } },
        { type: 'text', markdown: 'Day one.' }
      ]
    }
  ]);
  const res = await app.inject({ method: 'GET', url: '/trip' });
  assert.equal(res.statusCode, 200);
  const at = placement(res.body);
  assert.ok(at.figure > at.head && at.figure < at.main, 'banner sits between header and main');
  const article = res.body.slice(res.body.indexOf('<article>'));
  assert.doesNotMatch(article, /rkr-justify-bleed/, 'hero is not repeated in the body');
  assert.match(article, /Day one\./);
});

test('bannerAboveHeader puts a JSON page hero above the site header', async (t) => {
  const { root, app, page } = await setup(t, { bannerAboveHeader: true });
  const id = await ingestImage(root);
  page('top', [{ type: 'figure', slots: { ids: id, justify: 'bleed' } }]);
  const at = placement((await app.inject({ method: 'GET', url: '/top' })).body);
  assert.ok(at.figure > 0 && at.figure < at.head, 'banner above the header');
});

test('a figure after text stays in the body', async (t) => {
  const { root, app, page } = await setup(t);
  const id = await ingestImage(root);
  page('mid', [
    {
      type: 'flow',
      blocks: [
        { type: 'text', markdown: 'Intro.' },
        { type: 'figure', slots: { ids: id, justify: 'bleed' } }
      ]
    }
  ]);
  const at = placement((await app.inject({ method: 'GET', url: '/mid' })).body);
  assert.ok(at.figure > at.main, 'figure renders inside main');
});

test('one malformed macro file does not take down pages using a good macro', async (t) => {
  const { root, app, page } = await setup(t);
  fs.writeFileSync(path.join(root, 'macros', 'broken.json'), '{not json');
  fs.writeFileSync(
    path.join(root, 'macros', 'odd.json'),
    JSON.stringify({ defaults: {}, tree: { type: 'section', children: [{ type: 'mystery' }] } })
  );
  fs.writeFileSync(
    path.join(root, 'macros', 'hero.json'),
    JSON.stringify({
      defaults: { heading: 'Fresh food' },
      tree: { type: 'section', children: [{ type: 'text', markdown: '# {{heading}}' }] }
    })
  );
  page('home', [{ type: 'macro', macro: 'hero' }]);
  for (const url of ['/home', '/admin/blocks/edit/home', '/admin/blocks/macros']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, url);
  }
  assert.match((await app.inject({ method: 'GET', url: '/home' })).body, /Fresh food/);
  const macros = (await app.inject({ method: 'GET', url: '/admin/blocks/macros' })).json() as {
    name: string;
  }[];
  assert.deepEqual(
    macros.map((m) => m.name),
    ['hero']
  );
});
