import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import type { Sidecar } from '../../src/lib/sidecar-types.ts';
import { buildApp } from '../../src/server.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-post-bundle-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  const db = open(path.join(root, 'data', 'site.db'));
  migrate(db);
  db.close();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function setup(t: TestContext) {
  const root = freshSiteRoot(t);
  const db = open(path.join(root, 'data', 'site.db'));
  t.after(() => db.close());
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(() => app.close());
  return { root, app };
}

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);

function writeSidecar(root: string, id: string, sidecar: Sidecar): void {
  fs.writeFileSync(path.join(root, 'sidecars', `${id}.json`), JSON.stringify(sidecar, null, 2));
}

function writeOriginal(root: string, id: string, ext: string, bytes: number): void {
  const dir = path.join(root, 'originals', id.slice(0, 2), id.slice(2, 4));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.${ext}`), Buffer.alloc(bytes, 0xff));
}

function makeSidecar(format: string): Sidecar {
  return {
    version: 1,
    original: 'unused',
    source: { kind: 'upload' },
    metadata: { format, width: 800, height: 600 },
    ops: [],
    outputs: [],
    variants: []
  };
}

test('GET /admin/post-bundle/:slug?manifest=1 returns frontmatter + markdown + originals + sidecars', async (t) => {
  const { root, app } = await setup(t);

  // Two image references in the post body — both have sidecars +
  // originals on disk. The manifest should list both.
  const md = `---
title: Pin me
slug: pinme
date: 2026-05-09T12:00:00Z
status: published
---

Body with image ::image{#${ID_A.slice(0, 8)} alt="a"}
And gallery ::gallery{ids=[${ID_A.slice(0, 8)}, ${ID_B.slice(0, 8)}]}
`;
  fs.writeFileSync(path.join(root, 'content', 'posts', 'pinme.md'), md);
  writeSidecar(root, ID_A, makeSidecar('jpeg'));
  writeSidecar(root, ID_B, makeSidecar('png'));
  writeOriginal(root, ID_A, 'jpg', 1024);
  writeOriginal(root, ID_B, 'png', 512);

  const res = await app.inject({
    method: 'GET',
    url: '/admin/post-bundle/pinme?manifest=1'
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<{
    slug: string;
    title: string;
    status: string;
    lastModified: string;
    markdown: string;
    originals: { id: string; ext: string; bytes: number }[];
    sidecars: { id: string; json: Sidecar }[];
  }>();
  assert.equal(body.slug, 'pinme');
  assert.equal(body.title, 'Pin me');
  assert.equal(body.status, 'published');
  assert.match(body.markdown, /Body with image ::image/);
  assert.ok(!body.markdown.startsWith('---'), 'markdown must not contain frontmatter');
  assert.match(body.lastModified, /^\d{4}-\d{2}-\d{2}T/);

  // Originals: both, sorted by id.
  assert.equal(body.originals.length, 2);
  assert.deepEqual(body.originals.map((o) => o.id).sort(), [ID_A, ID_B].sort());
  assert.equal(body.originals.find((o) => o.id === ID_A)?.ext, 'jpg');
  assert.equal(body.originals.find((o) => o.id === ID_A)?.bytes, 1024);

  // Sidecars: both, format preserved.
  assert.equal(body.sidecars.length, 2);
  assert.equal(body.sidecars.find((s) => s.id === ID_A)?.json.metadata.format, 'jpeg');
});

test('GET /admin/post-bundle/:slug?manifest=1: sidecar-only references survive (skipped from originals)', async (t) => {
  const { root, app } = await setup(t);

  // Sidecar exists but the original on disk is gone — bundle should
  // still emit the sidecar entry but skip the original.
  const md = `---
title: Half ref
slug: halfref
date: 2026-05-09T12:00:00Z
status: draft
---

::image{#${ID_A.slice(0, 8)} alt="x"}
`;
  fs.writeFileSync(path.join(root, 'content', 'posts', 'halfref.md'), md);
  writeSidecar(root, ID_A, makeSidecar('jpeg'));
  // No original written.

  const res = await app.inject({ method: 'GET', url: '/admin/post-bundle/halfref?manifest=1' });
  assert.equal(res.statusCode, 200);
  const body = res.json<{
    sidecars: { id: string }[];
    originals: { id: string }[];
  }>();
  assert.equal(body.sidecars.length, 1);
  assert.equal(body.originals.length, 0);
});

test('GET /admin/post-bundle/:slug returns 404 for unknown slug', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/admin/post-bundle/nope?manifest=1' });
  assert.equal(res.statusCode, 404);
});

test('GET /admin/post-bundle/:slug rejects bad slugs and missing ?manifest=1', async (t) => {
  const { app } = await setup(t);
  const bad1 = await app.inject({
    method: 'GET',
    url: '/admin/post-bundle/has%20space?manifest=1'
  });
  assert.equal(bad1.statusCode, 400);
  const bad2 = await app.inject({ method: 'GET', url: '/admin/post-bundle/anything' });
  assert.equal(bad2.statusCode, 400);
});
