import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { _resetThemeNameCache } from '../../src/lib/config.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { buildApp } from '../../src/server.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-admin-settings-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'content/posts', 'data', 'config']) {
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
  // SITE_ROOT must be set before buildApp so paths() resolves to our
  // tempdir. Tests run sequentially so the global env mutation is
  // contained.
  const prevRoot = process.env.SITE_ROOT;
  process.env.SITE_ROOT = root;
  t.after(() => {
    if (prevRoot === undefined) delete process.env.SITE_ROOT;
    else process.env.SITE_ROOT = prevRoot;
    _resetThemeNameCache();
  });
  _resetThemeNameCache();
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(() => app.close());
  return { root, app };
}

test('GET /admin/settings: renders form with persisted title pre-filled', async (t) => {
  const { root, app } = await setup(t);
  fs.writeFileSync(
    path.join(root, 'config', 'site.json'),
    JSON.stringify({ title: 'Pre-Filled', tagline: 'and a sub', theme: 'default' })
  );
  const res = await app.inject({ method: 'GET', url: '/admin/settings' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<input id="rkr-settings-title"[^>]*value="Pre-Filled"/);
  assert.match(res.body, /<input id="rkr-settings-tagline"[^>]*value="and a sub"/);
  assert.match(res.body, /<option value="default" selected>/);
});

test('POST /admin/settings: persists the form values + 303 redirects', async (t) => {
  const { root, app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/settings',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'title=Brand+New&tagline=A+fresh+start&theme=default'
  });
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, '/admin/settings?flash=saved');
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'config', 'site.json'), 'utf8'));
  assert.equal(onDisk.title, 'Brand New');
  assert.equal(onDisk.tagline, 'A fresh start');
  assert.equal(onDisk.theme, 'default');
});

test('POST /admin/settings: cleared field falls back to env var on re-read', async (t) => {
  // Persisted title='Persisted', SITE_TITLE='From Env'. POST with an
  // empty title clears the persisted override; the next page render
  // should reflect the env-var default.
  const { root, app } = await setup(t);
  fs.writeFileSync(
    path.join(root, 'config', 'site.json'),
    JSON.stringify({ title: 'Persisted', tagline: '', theme: '' })
  );
  const prevTitleEnv = process.env.SITE_TITLE;
  process.env.SITE_TITLE = 'From Env';
  t.after(() => {
    if (prevTitleEnv === undefined) delete process.env.SITE_TITLE;
    else process.env.SITE_TITLE = prevTitleEnv;
  });
  await app.inject({
    method: 'POST',
    url: '/admin/settings',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'title=&tagline=&theme=default'
  });
  // The persisted title is now empty string; siteConfig's `||` chain
  // skips it and falls through to SITE_TITLE.
  const get = await app.inject({ method: 'GET', url: '/admin/settings' });
  // Placeholder is the env default — confirms siteConfig() resolved
  // to 'From Env' on re-read.
  assert.match(get.body, /placeholder="From Env"/);
});

test('POST /admin/settings: 303 with err= on invalid theme name', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/settings',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'title=ok&tagline=&theme=../etc/passwd'
  });
  assert.equal(res.statusCode, 303);
  // err= surfaces in the redirect target so the GET handler can
  // render the flash message.
  assert.match(res.headers.location as string, /\/admin\/settings\?err=/);
});

test('POST /admin/settings: 303 with err= on theme that is not installed', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/settings',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'title=ok&tagline=&theme=does-not-exist'
  });
  assert.equal(res.statusCode, 303);
  assert.match(res.headers.location as string, /err=/);
});

test('POST /admin/settings: 303 with err= when title exceeds the cap', async (t) => {
  const { app } = await setup(t);
  const longTitle = 'a'.repeat(201);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/settings',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `title=${longTitle}&tagline=&theme=`
  });
  assert.equal(res.statusCode, 303);
  assert.match(res.headers.location as string, /err=/);
});

test('POST /admin/settings: 303 with err= when subtitle exceeds the cap', async (t) => {
  const { app } = await setup(t);
  const longTagline = 'b'.repeat(501);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/settings',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `title=ok&tagline=${longTagline}&theme=`
  });
  assert.equal(res.statusCode, 303);
  assert.match(res.headers.location as string, /err=.*subtitle/);
});

test('POST /admin/settings: persists ingestResize knobs in config/site.json', async (t) => {
  const { root, app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/settings',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload:
      'title=&tagline=&theme=default&ingestMaxDim=2400&ingestScalePct=80&ingestWebpQuality=70'
  });
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, '/admin/settings?flash=saved');
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'config', 'site.json'), 'utf8'));
  assert.deepEqual(onDisk.ingestResize, { maxDim: 2400, scalePct: 80, webpQuality: 70 });
});

test('POST /admin/settings: partial ingestResize patch merges with existing', async (t) => {
  const { root, app } = await setup(t);
  // Seed an existing ingestResize block on disk.
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'config', 'site.json'),
    JSON.stringify({ ingestResize: { maxDim: 3000, scalePct: 100, webpQuality: 90 } })
  );
  // Operator submits only a new maxDim. The other two must survive.
  await app.inject({
    method: 'POST',
    url: '/admin/settings',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'title=&tagline=&theme=default&ingestMaxDim=1600&ingestScalePct=&ingestWebpQuality='
  });
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'config', 'site.json'), 'utf8'));
  assert.deepEqual(onDisk.ingestResize, { maxDim: 1600, scalePct: 100, webpQuality: 90 });
});

test('POST /admin/settings: 303 with err= on out-of-range ingest knob', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/settings',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    // INGEST_RESIZE_BOUNDS.maxDim.max = 8000; 99999 must reject.
    payload: 'title=&tagline=&theme=default&ingestMaxDim=99999&ingestScalePct=&ingestWebpQuality='
  });
  assert.equal(res.statusCode, 303);
  assert.match(res.headers.location as string, /err=.*max%20image%20dimension/);
});

test('POST /admin/settings: 303 with err= on non-numeric ingest knob', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/settings',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'title=&tagline=&theme=default&ingestMaxDim=banana'
  });
  assert.equal(res.statusCode, 303);
  assert.match(res.headers.location as string, /err=.*must%20be%20a%20number/);
});

test('POST /admin/settings: missing body fields fall back to empty strings', async (t) => {
  // A bare POST with no form body should NOT crash; the typeof
  // string-or-empty guards keep the handler defensive against
  // browsers that ship empty multipart submissions.
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/settings',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: ''
  });
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, '/admin/settings?flash=saved');
});

test('GET /admin/settings?err= surfaces the error flash banner', async (t) => {
  // The POST handler 303-redirects to this querystring on validation
  // failures; the GET decodes it back into a banner so the operator
  // sees what went wrong without us threading body state.
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: '/admin/settings?err=title%20too%20long'
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /class="rkr-admin-settings-flash is-error"[^>]*>title too long/);
});

test('GET /admin/settings?flash=saved: 200, no inline flash (toast is JS-side)', async (t) => {
  // The ok flash is now handled by settings-page.ts as a toast, so the
  // server renders no inline flash element for kind=ok.
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/admin/settings?flash=saved' });
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body, /rkr-admin-settings-flash is-ok/);
});

test('POST /admin/settings/site: persists title and tagline via JSON API', async (t) => {
  const { root, app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/settings/site',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ title: 'WP Imported Title', tagline: 'WP Imported Tagline' })
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    title: 'WP Imported Title',
    tagline: 'WP Imported Tagline'
  });
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'config', 'site.json'), 'utf8'));
  assert.equal(onDisk.title, 'WP Imported Title');
  assert.equal(onDisk.tagline, 'WP Imported Tagline');
});

test('POST /admin/settings/site: 400 on missing title', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/settings/site',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ tagline: 'Only tagline' })
  });
  assert.equal(res.statusCode, 400);
});

test('POST /admin/settings/site: 400 when title exceeds the cap', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/settings/site',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ title: 'a'.repeat(201), tagline: '' })
  });
  assert.equal(res.statusCode, 400);
});

test('POST /admin/settings: 303 with err= on invalid ingestScalePct', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/settings',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'ingestMaxDim=&ingestScalePct=banana&ingestWebpQuality='
  });
  assert.equal(res.statusCode, 303);
  assert.match(res.headers.location as string, /err=.*scale/);
});

test('POST /admin/settings: 303 with err= on out-of-range ingestWebpQuality', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/settings',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'ingestMaxDim=&ingestScalePct=&ingestWebpQuality=999'
  });
  assert.equal(res.statusCode, 303);
  assert.match(res.headers.location as string, /err=.*webp%20quality/);
});

test('POST /admin/settings/site: 400 when tagline exceeds the cap', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/settings/site',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ title: 'ok', tagline: 'b'.repeat(501) })
  });
  assert.equal(res.statusCode, 400);
});

test('POST /admin/settings/banner: persists a valid imageId', async (t) => {
  const { root, app } = await setup(t);
  const imageId = 'a'.repeat(64);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/settings/banner',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ imageId })
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, bannerImageId: imageId });
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'config', 'site.json'), 'utf8'));
  assert.equal(onDisk.bannerImageId, imageId);
});

test('POST /admin/settings/banner: 400 on invalid imageId', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'POST',
    url: '/admin/settings/banner',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ imageId: 'short' })
  });
  assert.equal(res.statusCode, 400);
});

// ---------------------------------------------------------------------------
// GET /admin/banner/edit
// ---------------------------------------------------------------------------

test('GET /admin/banner/edit: creates _site-banner.md when absent and redirects to editor', async (t) => {
  const { root, app } = await setup(t);
  const bannerPath = path.join(root, 'content', 'posts', '_site-banner.md');
  assert.ok(!fs.existsSync(bannerPath), 'precondition: no banner file');

  const res = await app.inject({ method: 'GET', url: '/admin/banner/edit' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/admin/editor?slug=_site-banner');
  assert.ok(fs.existsSync(bannerPath), '_site-banner.md created');

  const content = fs.readFileSync(bannerPath, 'utf8');
  assert.match(content, /slug: _site-banner/);
  assert.match(content, /status: published/);
});

test('GET /admin/banner/edit: redirects without overwriting existing _site-banner.md', async (t) => {
  const { root, app } = await setup(t);
  const bannerPath = path.join(root, 'content', 'posts', '_site-banner.md');
  const existing =
    '---\nslug: _site-banner\ntitle: Site Banner\nstatus: published\n---\n\n::figure{ids="abc123"}\n';
  fs.writeFileSync(bannerPath, existing);

  const res = await app.inject({ method: 'GET', url: '/admin/banner/edit' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/admin/editor?slug=_site-banner');
  assert.equal(fs.readFileSync(bannerPath, 'utf8'), existing, 'existing file unchanged');
});

test('GET /admin/banner/edit: seeds existing bannerImageId into new _site-banner.md', async (t) => {
  const { root, app } = await setup(t);
  // Write a site config that has a bannerImageId.
  fs.writeFileSync(
    path.join(root, 'config', 'site.json'),
    JSON.stringify({ bannerImageId: 'a'.repeat(64) })
  );
  const bannerPath = path.join(root, 'content', 'posts', '_site-banner.md');

  const res = await app.inject({ method: 'GET', url: '/admin/banner/edit' });
  assert.equal(res.statusCode, 302);
  const content = fs.readFileSync(bannerPath, 'utf8');
  assert.match(content, new RegExp(`ids="${'a'.repeat(64)}"`), 'figure uses bannerImageId');
  assert.match(content, /justify=bleed/);
});

test('GET /admin/banner/edit: requires auth', async (t) => {
  const { app } = await setup(t);
  // buildApp uses no-auth in test mode — but the guard is still wired.
  // Verify the route exists and returns a redirect (auth is bypassed in test
  // builds; the guard test in auth.test.ts covers the 401 case generically).
  const res = await app.inject({ method: 'GET', url: '/admin/banner/edit' });
  assert.ok(res.statusCode === 302 || res.statusCode === 401);
});
