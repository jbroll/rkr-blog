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

function writeFooter(root: string, status: string, markdown: string): string {
  const file = path.join(root, 'content', 'blocks', '_footer.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const page = {
    version: 1,
    body: [{ type: 'grid', children: [{ type: 'text', markdown }] }],
    fields: { title: 'Footer', slug: '_footer', status, kind: 'page' }
  };
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(page));
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

test('loadChrome: a published _footer renders; a draft or missing one does not', async (t) => {
  const root = freshSiteRoot(t);
  assert.equal((await loadChrome(root, {}, log)).footerHtml, undefined);
  writeFooter(root, 'draft', 'Hidden words');
  assert.equal((await loadChrome(root, {}, log)).footerHtml, undefined);
  writeFooter(root, 'published', 'Visible words');
  assert.match((await loadChrome(root, {}, log)).footerHtml ?? '', /Visible words/);
});

test('loadChrome: a footer progress block with source site gets the campaign', async (t) => {
  const root = freshSiteRoot(t);
  const file = path.join(root, 'content', 'blocks', '_footer.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      body: [{ type: 'progress', slots: { source: 'site' } }],
      fields: { title: 'Footer', slug: '_footer', status: 'published', kind: 'page' }
    })
  );
  const chrome = await loadChrome(root, { campaign: { goal: 5000, raised: 1250 } }, log);
  assert.match(chrome.footerHtml ?? '', /rkr-progress-raised">1,250<\/span> of .*">5,000</);
});

test('loadChrome: an unchanged _footer is not re-rendered and an edit shows', async (t) => {
  const root = freshSiteRoot(t);
  fs.mkdirSync(path.join(root, 'macros'), { recursive: true });
  writeFooter(root, 'published', 'First words');
  const macros = path.join(root, 'macros');
  const readdir = t.mock.method(fs, 'readdirSync');
  const scans = () =>
    readdir.mock.calls.filter((c) => path.resolve(String(c.arguments[0])) === macros).length;

  assert.match((await loadChrome(root, {}, log)).footerHtml ?? '', /First words/);
  const afterFirst = scans();
  assert.ok(afterFirst > 0, 'first render loads the macro library');
  assert.match((await loadChrome(root, {}, log)).footerHtml ?? '', /First words/);
  assert.equal(scans(), afterFirst, 'second render came from the cache');

  writeFooter(root, 'published', 'Second words');
  assert.match((await loadChrome(root, {}, log)).footerHtml ?? '', /Second words/);
  assert.ok(scans() > afterFirst, 'the edit re-rendered');
});

test('loadChrome: a _footer stored under another filename is not used', async (t) => {
  const root = freshSiteRoot(t);
  const file = writeFooter(root, 'published', 'Misfiled words');
  fs.renameSync(file, path.join(path.dirname(file), 'a-footer.json'));
  assert.equal((await loadChrome(root, {}, log)).footerHtml, undefined);
});

test('loadChrome: the cached footer expires after 60 seconds', async (t) => {
  const root = freshSiteRoot(t);
  const macros = path.join(root, 'macros');
  fs.mkdirSync(macros, { recursive: true });
  writeFooter(root, 'published', 'Words');
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const readdir = t.mock.method(fs, 'readdirSync');
  const scans = () =>
    readdir.mock.calls.filter((c) => path.resolve(String(c.arguments[0])) === macros).length;
  await loadChrome(root, {}, log);
  const first = scans();
  now += 59_000;
  await loadChrome(root, {}, log);
  assert.equal(scans(), first);
  now += 2_000;
  await loadChrome(root, {}, log);
  assert.ok(scans() > first);
});

test('loadChrome: a footer render failure is logged and leaves the default footer', async (t) => {
  const root = freshSiteRoot(t);
  const macros = path.join(root, 'macros');
  fs.mkdirSync(macros, { recursive: true });
  writeFooter(root, 'published', 'Words');
  const real = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', ((p: fs.PathLike, ...rest: unknown[]) => {
    if (path.resolve(String(p)) === macros) throw new Error('boom');
    return (real as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readdirSync);
  const warned: string[] = [];
  const chrome = await loadChrome(root, {}, { warn: (_o, msg) => warned.push(msg) });
  assert.equal(chrome.footerHtml, undefined);
  assert.equal(warned.length, 1);
});

test('loadChrome: a macro change re-renders the footer', async (t) => {
  const root = freshSiteRoot(t);
  const macros = path.join(root, 'macros');
  fs.mkdirSync(macros, { recursive: true });
  writeFooter(root, 'published', 'Words');
  const readdir = t.mock.method(fs, 'readdirSync');
  const scans = () =>
    readdir.mock.calls.filter((c) => path.resolve(String(c.arguments[0])) === macros).length;
  await loadChrome(root, {}, log);
  const before = scans();
  fs.writeFileSync(
    path.join(macros, 'x.json'),
    JSON.stringify({ defaults: {}, tree: { type: 'text', markdown: 'x' } })
  );
  await loadChrome(root, {}, log);
  assert.ok(scans() > before);
});

test('loadChrome: an empty site gives an empty chrome', async (t) => {
  const root = freshSiteRoot(t);
  assert.deepEqual(await loadChrome(root, {}, log), {});
});
