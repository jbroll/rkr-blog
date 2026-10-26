import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { renderBlocksEditPage } from '../../src/templates/admin-blocks-edit.ts';
import { renderBlocksPage } from '../../src/templates/blocks.ts';

const site = { title: 'rkroll' };
const assets = { theme: 'default', hash: 'abcdef012345', base: '/admin/static' };

const editHtml = renderBlocksEditPage({
  site,
  assets,
  slug: 'hello',
  bundleUrl: '/admin/static/admin/blocks-page-editor-entry.js?v=abcdef012345',
  isAdmin: true
});

test('renderBlocksEditPage: links the admin manifest and registers the admin SW', () => {
  assert.match(editHtml, /\/admin\/static\/admin-manifest\.webmanifest\?v=abcdef012345/);
  assert.match(editHtml, /\/admin\/static\/site\/sw-admin-register\.js\?v=abcdef012345/);
});

test('renderBlocksPage: the admin pages list registers the admin SW when asked', () => {
  const html = renderBlocksPage({
    site,
    assets,
    title: 'Pages',
    bodyHtml: '',
    isAdmin: true,
    adminPwa: true
  });
  assert.match(html, /\/admin\/static\/admin-manifest\.webmanifest/);
  assert.match(html, /sw-admin-register\.js/);
});

test('renderBlocksPage: public pages never register the admin SW', () => {
  const html = renderBlocksPage({ site, assets, title: 'A page', bodyHtml: '', isAdmin: true });
  assert.equal(html.includes('sw-admin-register'), false);
  assert.equal(html.includes('admin-manifest'), false);
});

test('the admin manifest starts the installed app on the pages list', () => {
  const file = path.resolve(import.meta.dirname, '../../static/admin-manifest.webmanifest');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as { start_url: string };
  assert.equal(manifest.start_url, '/admin/blocks');
});
