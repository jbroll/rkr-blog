import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { buildApp } from '../../src/server.ts';

const repo = path.resolve(import.meta.dirname, '..', '..');

test('GET /admin/view/:slug redirects to the block editor', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-view-redirect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/admin/view/hello-world' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/admin/blocks/edit/hello-world');
});

test('GET /admin/view/:slug encodes the slug into the redirect', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-view-redirect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = await buildApp({ siteRoot: root });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/admin/view/a%2F..%2Fb' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/admin/blocks/edit/a%2F..%2Fb');
});

test('the TipTap editor entry and the preview page are gone', () => {
  assert.equal(fs.existsSync(path.join(repo, 'src/admin/main.ts')), false);
  assert.equal(fs.existsSync(path.join(repo, 'src/admin/preview-page.ts')), false);
});

test('build:admin and knip no longer name the TipTap entry', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(pkg.scripts['build:admin']?.includes('main.ts'), false);
  assert.equal(
    Object.keys(pkg.devDependencies).some((d) => d.startsWith('@tiptap/')),
    false
  );
});

test('the tree-view card UI is gone; only pure tree ops remain', () => {
  const ops = path.join(repo, 'src/admin/block-tree-ops.ts');
  assert.equal(fs.existsSync(path.join(repo, 'src/admin/blocks-page-editor.ts')), false);
  const src = fs.readFileSync(ops, 'utf8');
  assert.equal(/\bdocument\b|HTMLElement/.test(src), false, 'tree ops touch no DOM');
  assert.equal(src.includes('moveNode'), false);
});
