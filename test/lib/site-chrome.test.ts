import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { ingestStream } from '../../src/lib/originals.ts';
import { loadChrome, renderLogoHtml } from '../../src/lib/site-chrome.ts';

const log = { warn: () => {} };

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-chrome-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'bakes', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function seed(root: string): Promise<string> {
  const bytes = await sharp({
    create: { width: 600, height: 200, channels: 3, background: { r: 10, g: 20, b: 30 } }
  })
    .png()
    .toBuffer();
  const r = await ingestStream({
    stream: Readable.from([bytes]),
    siteRoot: root,
    source: { kind: 'upload' }
  });
  return r.id;
}

test('renderLogoHtml: an ingested image renders an eager picture through /img', async (t) => {
  const root = freshSiteRoot(t);
  const id = await seed(root);
  const html = (await renderLogoHtml(root, id, log)) ?? '';
  assert.match(html, /^<picture>/);
  assert.match(html, new RegExp(`src="/img/${id}\\.[0-9a-f]+\\.jpeg"`));
  assert.match(html, /loading="eager"/);
  assert.match(html, /alt=""/);
});

test('renderLogoHtml reads the one sidecar without listing the sidecars directory', async (t) => {
  const root = freshSiteRoot(t);
  const id = await seed(root);
  const sidecars = path.join(root, 'sidecars');
  const readdir = t.mock.method(fs, 'readdirSync');
  const listed = () =>
    readdir.mock.calls.filter((c) => path.resolve(String(c.arguments[0])) === sidecars).length;
  assert.match((await renderLogoHtml(root, id, log)) ?? '', /<picture>/);
  assert.equal(await renderLogoHtml(root, 'd'.repeat(64), log), undefined);
  assert.equal(listed(), 0);
});

test('renderLogoHtml: unset or unknown id renders nothing', async (t) => {
  const root = freshSiteRoot(t);
  assert.equal(await renderLogoHtml(root, undefined, log), undefined);
  assert.equal(await renderLogoHtml(root, 'b'.repeat(64), log), undefined);
});

test('loadChrome: copies the header settings and renders the logo', async (t) => {
  const root = freshSiteRoot(t);
  const id = await seed(root);
  const chrome = await loadChrome(
    root,
    {
      logo: id,
      menu: [{ label: 'A', href: '/a' }],
      cta: { label: 'Join', href: '/join' },
      social: [{ platform: 'youtube', url: 'https://youtube.com/x' }],
      announcement: { text: 'Hi', on: true }
    },
    log
  );
  assert.match(chrome.logoHtml ?? '', /<picture>/);
  assert.deepEqual(chrome.menu, [{ label: 'A', href: '/a' }]);
  assert.deepEqual(chrome.cta, { label: 'Join', href: '/join' });
  assert.deepEqual(chrome.social, [{ platform: 'youtube', url: 'https://youtube.com/x' }]);
  assert.deepEqual(chrome.announcement, { text: 'Hi', on: true });
});

test('loadChrome: an empty site gives an empty chrome', async (t) => {
  const root = freshSiteRoot(t);
  assert.deepEqual(await loadChrome(root, {}, log), {});
});
