import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it, type TestContext } from 'node:test';
import sharp from 'sharp';

import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { ingestStream } from '../../src/lib/originals.ts';
import { buildApp } from '../../src/server.ts';

const TREE = {
  version: 1,
  body: [{ type: 'flow', blocks: [{ type: 'text', markdown: 'Saved.' }] }],
  fields: { title: 'Saved page', slug: 'saved' }
};

/** Ingest one real image so the figure widget's image map resolves it. */
async function ingestImage(root: string): Promise<string> {
  const jpeg = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 30, g: 60, b: 200 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  const { id } = await ingestStream({
    stream: Readable.from([jpeg]),
    siteRoot: root,
    source: { kind: 'upload', originalName: 'pic.jpg' }
  });
  return id;
}

/** Publish a block page through the real save route (writes the file and
 * reindexes), so `GET /:slug` serves it as the visitor-facing twin. */
async function publishPage(
  app: Awaited<ReturnType<typeof buildApp>>,
  slug: string,
  body: unknown[]
): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/admin/blocks/${slug}`,
    payload: { tree: { version: 1, body, fields: { title: slug, slug, status: 'published' } } }
  });
  assert.equal(res.statusCode, 200);
}

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
  return { root, app, db };
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

  it('POST /admin/blocks/:slug reindexes so the page is visible on / and /:slug', async (t) => {
    const { root, app } = await setup(t);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/blocks/fresh-page',
      payload: {
        tree: {
          version: 1,
          body: [{ type: 'text', markdown: 'Fresh body.' }],
          fields: { title: 'Fresh page', slug: 'fresh-page', status: 'published' }
        }
      }
    });
    assert.equal(res.statusCode, 200);
    assert.ok(fs.existsSync(path.join(root, 'content', 'blocks', 'fresh-page.json')));

    const home = await app.inject({ method: 'GET', url: '/' });
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /Fresh page/);

    const page = await app.inject({ method: 'GET', url: '/fresh-page' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Fresh body/);
  });

  it('POST /admin/blocks/:slug prewarms image variants referenced by the tree', async (t) => {
    const { root, app, db } = await setup(t);
    const id = 'e'.repeat(64);
    const originalDir = path.join(root, 'originals', id.slice(0, 2), id.slice(2, 4));
    fs.mkdirSync(originalDir, { recursive: true });
    fs.writeFileSync(path.join(originalDir, `${id}.webp`), Buffer.alloc(8));
    fs.mkdirSync(path.join(root, 'sidecars'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'sidecars', `${id}.json`),
      JSON.stringify({
        version: 1,
        original: id,
        source: {},
        ops: [],
        variants: [
          { w: 640, h: 480, fit: 'inside' },
          { w: 320, h: 240, fit: 'inside' }
        ],
        outputs: [{ format: 'webp', quality: 80 }]
      })
    );

    const res = await app.inject({
      method: 'POST',
      url: '/admin/blocks/with-image',
      payload: {
        tree: {
          version: 1,
          body: [{ type: 'figure', slots: { ids: id } }],
          fields: { title: 'With image', slug: 'with-image' }
        }
      }
    });
    assert.equal(res.statusCode, 200);

    const rows = db
      .prepare<{ kind: string; payload: string }>('SELECT kind, payload FROM jobs')
      .all();
    assert.equal(rows.length, 2, 'one job per variant × output');
    for (const row of rows) {
      assert.equal(row.kind, 'render');
      assert.equal((JSON.parse(row.payload) as { originalId: string }).originalId, id);
    }
  });

  it('GET /admin/blocks/macros lists the palette entries', async (t) => {
    const { root, app } = await setup(t);
    fs.writeFileSync(
      path.join(root, 'macros', 'hero.json'),
      JSON.stringify({ defaults: {}, tree: { type: 'text', markdown: 'Hi' } })
    );
    const res = await app.inject({ method: 'GET', url: '/admin/blocks/macros' });
    assert.equal(res.statusCode, 200);
    const list = JSON.parse(res.body) as {
      name: string;
      label: string;
      defaults?: Record<string, unknown>;
    }[];
    assert.ok(list.some((m) => m.name === 'hero' && typeof m.label === 'string'));
  });

  it('GET /admin/blocks/macros includes macro defaults for field editors', async (t) => {
    const { root, app } = await setup(t);
    fs.writeFileSync(
      path.join(root, 'macros', 'hero.json'),
      JSON.stringify({
        defaults: { heading: 'Fresh food' },
        tree: { type: 'text', markdown: 'Hi' }
      })
    );
    const res = await app.inject({ method: 'GET', url: '/admin/blocks/macros' });
    const list = JSON.parse(res.body) as { name: string; defaults?: Record<string, unknown> }[];
    assert.deepEqual(list.find((m) => m.name === 'hero')?.defaults, { heading: 'Fresh food' });
  });

  it('macros endpoint omits root macros and returns groups', async (t) => {
    const { root, app } = await setup(t);
    const tree = { type: 'text', markdown: 'Hi' };
    fs.writeFileSync(
      path.join(root, 'macros', 'hero.json'),
      JSON.stringify({
        description: 'Big opening band',
        defaults: { heading: 'Fresh' },
        fieldSchema: { heading: { label: 'Heading', type: 'text' } },
        tree
      })
    );
    fs.writeFileSync(
      path.join(root, 'macros', 'page.json'),
      JSON.stringify({ defaults: {}, tree })
    );
    const res = await app.inject({ method: 'GET', url: '/admin/blocks/macros' });
    const list = JSON.parse(res.body) as {
      name: string;
      group: string;
      description: string;
      fieldSchema: Record<string, { label: string }>;
    }[];
    assert.equal(
      list.some((m) => m.name === 'page'),
      false
    );
    const hero = list.find((m) => m.name === 'hero');
    assert.equal(hero?.group, 'Sections');
    assert.equal(hero?.description, 'Big opening band');
    assert.equal(hero?.fieldSchema.heading?.label, 'Heading');
  });

  it('macros endpoint falls back to a generic description and empty schema', async (t) => {
    const { root, app } = await setup(t);
    fs.writeFileSync(
      path.join(root, 'macros', 'plain.json'),
      JSON.stringify({ defaults: {}, tree: { type: 'text', markdown: 'Hi' } })
    );
    const res = await app.inject({ method: 'GET', url: '/admin/blocks/macros' });
    const plain = (
      JSON.parse(res.body) as { name: string; description: string; fieldSchema: object }[]
    ).find((m) => m.name === 'plain');
    assert.ok(plain?.description);
    assert.deepEqual(plain?.fieldSchema, {});
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
    // The editor's canvas preview pipeline renders a blob: URL; the
    // public CSP omits blob: and would make Chromium reject the decode.
    const csp = res.headers['content-security-policy'] as string;
    assert.match(csp, /img-src 'self' data: blob:/);
    assert.match(csp, /script-src 'self'/);
    // Drive, Photos and OneDrive picker thumbnails load from the providers.
    const img = csp.split('; ').find((d) => d.startsWith('img-src ')) ?? '';
    for (const host of [
      'https://*.googleusercontent.com',
      'https://*.1drv.com',
      'https://*.onedrive.live.com',
      'https://*.svc.ms'
    ]) {
      assert.ok(img.split(' ').includes(host), `editor img-src allows ${host}`);
    }
    assert.equal(
      (await app.inject({ method: 'GET', url: '/admin/blocks/edit/nope' })).statusCode,
      404
    );
  });

  it('public pages keep the tight CSP without blob:', async (t) => {
    const { app } = await setup(t);
    await publishPage(app, 'public-csp', [{ type: 'text', markdown: 'Hi' }]);
    const res = await app.inject({ method: 'GET', url: '/public-csp' });
    assert.equal(res.statusCode, 200);
    const csp = res.headers['content-security-policy'] as string;
    assert.match(csp, /img-src 'self' data:(;|$)/);
    assert.equal(csp.includes('blob:'), false);
    for (const host of ['googleusercontent', '1drv', 'onedrive', 'svc.ms']) {
      assert.equal(csp.includes(host), false, `public CSP omits ${host}`);
    }
  });

  it('GET /admin/blocks/edit/:slug renders the page body with path markers and the tree', async (t) => {
    const { root, app } = await setup(t);
    fs.writeFileSync(
      path.join(root, 'macros', 'hero.json'),
      JSON.stringify({ defaults: {}, tree: { type: 'text', markdown: 'Hero body' } })
    );
    fs.writeFileSync(
      path.join(root, 'content', 'blocks', 'saved.json'),
      JSON.stringify({
        version: 1,
        body: [
          { type: 'text', markdown: 'Edit me' },
          { type: 'section', children: [{ type: 'text', markdown: 'Inner' }] },
          { type: 'macro', macro: 'hero' }
        ],
        fields: { title: 'Saved', slug: 'saved' }
      })
    );
    const res = await app.inject({ method: 'GET', url: '/admin/blocks/edit/saved' });
    assert.equal(res.statusCode, 200);

    // The saved tree renders as the public page body (markdown,
    // containers, and macro expansion through the site macro library).
    assert.match(res.body, /<p>Edit me<\/p>/);
    assert.match(res.body, /<p>Inner<\/p>/);
    assert.match(res.body, /<p>Hero body<\/p>/);

    // One invisible path marker per rendered node, in document order.
    // The macro instance is one unit: its expansion is unmarked.
    const order = [...res.body.matchAll(/<!--rkr:path=([0-9,]+)-->/g)].map((m) => m[1]);
    assert.deepEqual(order, ['0', '1', '1,0', '2']);

    // The canonical tree is embedded for client hydration.
    const embed = res.body.match(
      /<script type="application\/json" id="rkr-tree">([\s\S]*?)<\/script>/
    );
    assert.ok(embed, 'edit page embeds #rkr-tree');
    const tree = JSON.parse(embed[1] as string) as {
      version: number;
      body: { type: string }[];
    };
    assert.equal(tree.version, 1);
    assert.deepEqual(
      tree.body.map((n) => n.type),
      ['text', 'section', 'macro']
    );
  });

  it('GET /admin/blocks/edit/:slug resolves page figures like the public route', async (t) => {
    const { root, app } = await setup(t);
    const id = await ingestImage(root);
    await publishPage(app, 'photo', [{ type: 'figure', slots: { ids: id } }]);

    const edit = await app.inject({ method: 'GET', url: '/admin/blocks/edit/photo' });
    assert.equal(edit.statusCode, 200);
    assert.match(edit.body, /<picture>/);
    assert.match(edit.body, /rkr-figure-cell/);
    assert.doesNotMatch(edit.body, /figure: no ids resolved/);

    // Parity with the visitor-facing page for the same tree: the edit
    // page uses identical resolved image sources.
    const pub = await app.inject({ method: 'GET', url: '/photo' });
    assert.equal(pub.statusCode, 200);
    assert.match(pub.body, /<picture>/);
    const srcsets = [...pub.body.matchAll(/srcset="([^"]+)"/g)].map((m) => m[1] as string);
    assert.ok(srcsets.length > 0, 'public page resolves image variants');
    for (const srcset of srcsets) assert.ok(edit.body.includes(srcset), `edit body has ${srcset}`);
  });

  it('GET /admin/blocks/edit/:slug resolves figures inside macro expansions', async (t) => {
    const { root, app } = await setup(t);
    const id = await ingestImage(root);
    fs.writeFileSync(
      path.join(root, 'macros', 'photo.json'),
      JSON.stringify({
        defaults: {},
        tree: { type: 'section', children: [{ type: 'figure', slots: { ids: id } }] }
      })
    );
    await publishPage(app, 'macro-photo', [{ type: 'macro', macro: 'photo' }]);

    const edit = await app.inject({ method: 'GET', url: '/admin/blocks/edit/macro-photo' });
    assert.equal(edit.statusCode, 200);
    assert.match(edit.body, /<picture>/);
    assert.doesNotMatch(edit.body, /figure: no ids resolved/);
    // The macro instance stays one editable unit.
    assert.match(edit.body, /<!--rkr:path=0-->/);

    // Visitors already see the photo; the edit page must match.
    const pub = await app.inject({ method: 'GET', url: '/macro-photo' });
    assert.equal(pub.statusCode, 200);
    assert.match(pub.body, /<picture>/);
    assert.doesNotMatch(pub.body, /figure: no ids resolved/);
  });

  it('POST /admin/blocks/_render returns marked html and writes nothing', async (t) => {
    const { root, app } = await setup(t);
    const blocksDir = path.join(root, 'content', 'blocks');
    fs.writeFileSync(path.join(blocksDir, 'saved.json'), JSON.stringify(TREE));
    const before = fs.readdirSync(blocksDir).length;
    const res = await app.inject({
      method: 'POST',
      url: '/admin/blocks/_render',
      payload: {
        tree: {
          version: 1,
          body: [
            { type: 'text', markdown: 'Rendered' },
            { type: 'text', markdown: '' }
          ]
        }
      }
    });
    assert.equal(res.statusCode, 200);
    const { html } = JSON.parse(res.body) as { html: string };
    assert.ok(html.includes('<!--rkr:path=0-->'));
    assert.match(html, /<p>Rendered<\/p>/);
    assert.match(html, /<!--rkr:path=1--><p class="rkr-unified-blank" data-rkr-blank><\/p>/);
    assert.equal(fs.readdirSync(blocksDir).length, before);
    assert.equal(fs.existsSync(path.join(blocksDir, '_render.json')), false);
  });

  it('render rejects an invalid tree', async (t) => {
    const { root, app } = await setup(t);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/blocks/_render',
      payload: { tree: { body: 'x' } }
    });
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /tree needs a body array/);
    assert.deepEqual(fs.readdirSync(path.join(root, 'content', 'blocks')), []);
  });

  it('a page slugged render saves like any other page', async (t) => {
    const { root, app } = await setup(t);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/blocks/render',
      payload: { tree: { ...TREE, fields: { title: 'Render', slug: 'render' } } }
    });
    assert.equal(res.statusCode, 200);
    const { version, ...rest } = JSON.parse(res.body);
    assert.deepEqual(rest, { slug: 'render', inserted: true });
    assert.equal(typeof version, 'string');
    assert.ok(fs.existsSync(path.join(root, 'content', 'blocks', 'render.json')));
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
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body, /Use lowercase letters, digits and hyphens\./);
  });
});

describe('admin blocks page fields', () => {
  const body = [{ type: 'flow', blocks: [{ type: 'text', markdown: 'Hi.' }] }];

  it('save merges request fields over stored fields', async (t) => {
    const { root, app } = await setup(t);
    const file = path.join(root, 'content', 'blocks', 'hello.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, body, fields: { title: 'A', slug: 'hello', tags: ['x'] } })
    );
    const res = await app.inject({
      method: 'POST',
      url: '/admin/blocks/hello',
      payload: { tree: { version: 1, body, fields: { status: 'published' } } }
    });
    assert.equal(res.statusCode, 200);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.fields, { title: 'A', slug: 'hello', tags: ['x'], status: 'published' });
  });

  it('save does not read other pages', async (t) => {
    const { root, app } = await setup(t);
    fs.writeFileSync(path.join(root, 'content', 'blocks', 'other.json'), '{ not json');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/blocks/hello',
      payload: { tree: { version: 1, body, fields: { title: 'Hello' } } }
    });
    assert.equal(res.statusCode, 200);
    const saved = JSON.parse(
      fs.readFileSync(path.join(root, 'content', 'blocks', 'hello.json'), 'utf8')
    );
    assert.equal(saved.fields.title, 'Hello');
  });

  it('new page with taken slug re-renders the form with an error', async (t) => {
    const { app } = await setup(t);
    const make = () =>
      app.inject({
        method: 'POST',
        url: '/admin/blocks/new',
        payload: { title: 'Spring Sale', slug: 'spring-sale' }
      });
    assert.equal((await make()).statusCode, 303);
    const again = await make();
    assert.equal(again.statusCode, 409);
    assert.match(again.body, /already exists/);
    assert.match(again.body, /value="Spring Sale"/);
  });

  it('new page stores the title and starts as a draft', async (t) => {
    const { root, app } = await setup(t);
    await app.inject({
      method: 'POST',
      url: '/admin/blocks/new',
      payload: { title: 'Spring Sale', slug: 'spring-sale' }
    });
    const saved = JSON.parse(
      fs.readFileSync(path.join(root, 'content', 'blocks', 'spring-sale.json'), 'utf8')
    );
    assert.deepEqual(saved.fields, { title: 'Spring Sale', slug: 'spring-sale', status: 'draft' });
  });

  it('edit page embeds the stored fields for the settings dialog', async (t) => {
    const { root, app } = await setup(t);
    fs.writeFileSync(
      path.join(root, 'content', 'blocks', 'hello.json'),
      JSON.stringify({ version: 1, body, fields: { title: 'A', slug: 'hello', tags: ['x'] } })
    );
    const res = await app.inject({ method: 'GET', url: '/admin/blocks/edit/hello' });
    const json = /id="rkr-tree">([^<]*)</.exec(res.body)?.[1] ?? '';
    assert.deepEqual(JSON.parse(json).fields.tags, ['x']);
  });

  it('save writes back to the migrated file that holds the slug', async (t) => {
    const { root, app } = await setup(t);
    const dir = path.join(root, 'content', 'blocks');
    const file = path.join(dir, '2020-03-04-my-post.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, body, fields: { title: 'Mine', slug: 'my-post', tags: ['x'] } })
    );
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/blocks/my-post',
      payload: { tree: { version: 1, body, fields: { status: 'published' } } }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(fs.existsSync(path.join(dir, 'my-post.json')), false);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.fields, {
      title: 'Mine',
      slug: 'my-post',
      tags: ['x'],
      status: 'published'
    });
  });

  const page = (slug: string, title: string, bodyNodes: unknown = body) =>
    JSON.stringify({ version: 1, body: bodyNodes, fields: { title, slug } });

  it('editor and save use the same file when two files claim a slug', async (t) => {
    const { root, app } = await setup(t);
    const dir = path.join(root, 'content', 'blocks');
    fs.writeFileSync(path.join(dir, 'a-first.json'), page('dup', 'First'));
    fs.writeFileSync(path.join(dir, 'b-second.json'), page('dup', 'Second'));
    const edit = await app.inject({ method: 'GET', url: '/admin/blocks/edit/dup' });
    assert.match(edit.body, /First/);
    await app.inject({
      method: 'POST',
      url: '/admin/blocks/dup',
      payload: { tree: { version: 1, body, fields: { status: 'published' } } }
    });
    const first = JSON.parse(fs.readFileSync(path.join(dir, 'a-first.json'), 'utf8'));
    assert.equal(first.fields.status, 'published');
    assert.equal(fs.existsSync(path.join(dir, 'dup.json')), false);
    const second = JSON.parse(fs.readFileSync(path.join(dir, 'b-second.json'), 'utf8'));
    assert.equal(second.fields.status, undefined);
  });

  it('an invalid-tree first match is skipped by the editor and the save', async (t) => {
    const { root, app } = await setup(t);
    const dir = path.join(root, 'content', 'blocks');
    fs.writeFileSync(path.join(dir, 'a-bad.json'), page('dup', 'Bad', 'not an array'));
    fs.writeFileSync(path.join(dir, 'b-good.json'), page('dup', 'Good'));
    const edit = await app.inject({ method: 'GET', url: '/admin/blocks/edit/dup' });
    assert.match(edit.body, /Good/);
    await app.inject({
      method: 'POST',
      url: '/admin/blocks/dup',
      payload: { tree: { version: 1, body, fields: { status: 'published' } } }
    });
    const good = JSON.parse(fs.readFileSync(path.join(dir, 'b-good.json'), 'utf8'));
    assert.equal(good.fields.title, 'Good');
    assert.equal(good.fields.status, 'published');
    assert.equal(fs.existsSync(path.join(dir, 'dup.json')), false);
  });

  it('new page treats a mismatched <slug>.json as taken', async (t) => {
    const { root, app } = await setup(t);
    const file = path.join(root, 'content', 'blocks', 'taken.json');
    const original = page('something-else', 'Other');
    fs.writeFileSync(file, original);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/blocks/new',
      payload: { title: 'Taken', slug: 'taken' }
    });
    assert.equal(res.statusCode, 409);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });

  it('save refuses to overwrite another page that owns <slug>.json', async (t) => {
    const { root, app } = await setup(t);
    const file = path.join(root, 'content', 'blocks', 'taken.json');
    const original = JSON.stringify({
      version: 1,
      body,
      fields: { title: 'Other', slug: 'something-else' }
    });
    fs.writeFileSync(file, original);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/blocks/taken',
      payload: { tree: { version: 1, body, fields: { title: 'Mine' } } }
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'slug collides with an existing file');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });
});

describe('admin blocks save versions', () => {
  const tree = (markdown: string) => ({
    version: 1,
    body: [{ type: 'text', markdown }],
    fields: { title: 'Versioned', slug: 'versioned' }
  });
  const post = (app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/admin/blocks/versioned', payload });

  it('stale baseVersion returns 409', async (t) => {
    const { root, app } = await setup(t);
    const first = await post(app, { tree: tree('One') });
    assert.equal(first.statusCode, 200);
    const v1 = first.json().version as string;
    assert.equal(typeof v1, 'string');

    const second = await post(app, { tree: tree('Two'), baseVersion: v1 });
    assert.equal(second.statusCode, 200);
    const v2 = second.json().version as string;
    assert.notEqual(v2, v1);

    const file = path.join(root, 'content', 'blocks', 'versioned.json');
    const before = fs.readFileSync(file, 'utf8');
    const stale = await post(app, { tree: tree('Three'), baseVersion: v1 });
    assert.equal(stale.statusCode, 409);
    assert.deepEqual(stale.json(), { error: 'conflict', version: v2 });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

  it('missing baseVersion still saves', async (t) => {
    const { app } = await setup(t);
    await post(app, { tree: tree('One') });
    await post(app, { tree: tree('Two') });
    const res = await post(app, { tree: tree('Three') });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().inserted, false);
    const stored = await app.inject({ method: 'GET', url: '/admin/blocks/versioned' });
    assert.equal(stored.json().tree.body[0].markdown, 'Three');
  });

  it('the edit page embeds the version of the file it rendered', async (t) => {
    const { root, app } = await setup(t);
    const dir = path.join(root, 'content', 'blocks');
    fs.writeFileSync(path.join(dir, '2020-01-02-versioned.json'), JSON.stringify(tree('Dated')));
    const edit = await app.inject({ method: 'GET', url: '/admin/blocks/edit/versioned' });
    const version = /data-version="([^"]+)"/.exec(edit.body)?.[1];
    assert.ok(version, 'edit root carries data-version');
    const saved = await post(app, { tree: tree('Again'), baseVersion: version });
    assert.equal(saved.statusCode, 200);
    assert.equal(fs.existsSync(path.join(dir, 'versioned.json')), false);
  });
});
