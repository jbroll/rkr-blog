import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { events } from '../../src/lib/jobs.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { runReindex } from '../../src/lib/post-index.ts';
import { createSession } from '../../src/lib/sessions.ts';
import { findOrCreateOAuthUser, inviteEmail } from '../../src/lib/users.ts';
import type { TokenExchange } from '../../src/routes/auth.ts';
import { buildApp } from '../../src/server.ts';

const noopAuthExchange: TokenExchange = {
  authorizationUrl: () => new URL('https://example.com/'),
  exchange: async () => {
    throw new Error('not used');
  }
};

async function setup(t: TestContext, site: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-coll-'));
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
    site: { title: 'Coll Site', ...site },
    auth: { exchange: noopAuthExchange, secureCookies: false, allowedOrigins: ['http://localhost'] }
  });
  t.after(async () => {
    await app.close();
    events.removeAllListeners('enqueued');
  });
  const page = (slug: string, fields: Record<string, unknown> = {}) => {
    fs.writeFileSync(
      path.join(root, 'content', 'blocks', `${slug}.json`),
      JSON.stringify({
        version: 1,
        body: [{ type: 'text', markdown: `Body of ${slug}.` }],
        fields: { title: `Title ${slug}`, slug, status: 'published', kind: 'page', ...fields }
      })
    );
    runReindex(root);
  };
  const adminCookie = () => {
    inviteEmail(db, 'op@x.com', 'owner');
    const user = findOrCreateOAuthUser(db, { provider: 'google', sub: 'op-1', email: 'op@x.com' });
    return `rkr_session=${createSession(db, { userId: user.id }).id}`;
  };
  const get = (url: string, cookie?: string) =>
    app.inject({ method: 'GET', url, ...(cookie ? { headers: { cookie } } : {}) });
  return { page, get, adminCookie };
}

test('GET /board/alice renders alice with a back link', async (t) => {
  const { page, get } = await setup(t);
  page('board');
  page('alice', { tags: ['board'] });
  const res = await get('/board/alice');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Body of alice\./);
  assert.match(res.body, /class="rkr-collection-back" href="\/board"/);
});

test('GET /recipes/alice is 404 when alice belongs to board', async (t) => {
  const { page, get } = await setup(t);
  page('board');
  page('recipes');
  page('alice', { tags: ['board'] });
  assert.equal((await get('/recipes/alice')).statusCode, 404);
});

test('a draft board page makes /board/alice 404 and /alice serve with no redirect', async (t) => {
  const { page, get } = await setup(t);
  page('board', { status: 'draft' });
  page('alice', { tags: ['board'] });
  assert.equal((await get('/board/alice')).statusCode, 404);
  const flat = await get('/alice');
  assert.equal(flat.statusCode, 200);
  assert.doesNotMatch(flat.body, /rkr-collection-nav/);
});

test('GET /board/draftmember is 404 anonymous and 200 for an admin', async (t) => {
  const { page, get, adminCookie } = await setup(t);
  page('board');
  page('draftmember', { tags: ['board'], status: 'draft' });
  assert.equal((await get('/board/draftmember')).statusCode, 404);
  assert.equal((await get('/draftmember')).statusCode, 404);
  const res = await get('/board/draftmember', adminCookie());
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /rkr-collection-back/);
});

test('GET /alice 302s to /board/alice, for an admin too', async (t) => {
  const { page, get, adminCookie } = await setup(t);
  page('board');
  page('alice', { tags: ['board'] });
  for (const cookie of [undefined, adminCookie()]) {
    const res = await get('/alice', cookie);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/board/alice');
  }
});

test('GET /alice?submitted=1 keeps the query string', async (t) => {
  const { page, get } = await setup(t);
  page('board');
  page('alice', { tags: ['board'] });
  const res = await get('/alice?submitted=1');
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/board/alice?submitted=1');
});

test('home page rule wins over the collection redirect', async (t) => {
  const { page, get } = await setup(t, { homePage: 'alice' });
  page('board');
  page('alice', { tags: ['board'] });
  const res = await get('/alice');
  assert.equal(res.statusCode, 301);
  assert.equal(res.headers.location, '/');
});

test('legacy permalink 302s a member straight to its nested URL', async (t) => {
  const { page, get } = await setup(t);
  page('board');
  page('alice', { tags: ['board'] });
  page('bob');
  const member = await get('/2020/01/02/alice');
  assert.equal(member.statusCode, 302);
  assert.equal(member.headers.location, '/board/alice');
  const flat = await get('/2020/01/02/bob');
  assert.equal(flat.statusCode, 301);
  assert.equal(flat.headers.location, '/bob');
});

test('GET /pages/alice 302s a member to its nested URL; a non-member keeps 301', async (t) => {
  const { page, get } = await setup(t);
  page('board');
  page('alice', { tags: ['board'] });
  page('bob');
  const member = await get('/pages/alice');
  assert.equal(member.statusCode, 302);
  assert.equal(member.headers.location, '/board/alice');
  const flat = await get('/pages/bob');
  assert.equal(flat.statusCode, 301);
  assert.equal(flat.headers.location, '/bob');
});

test('GET /pages/x still routes to /pages/:slug, not /:collection/:slug', async (t) => {
  const { page, get } = await setup(t);
  page('pages');
  page('x', { tags: ['pages'] });
  const res = await get('/pages/x');
  assert.equal(res.statusCode, 301);
  assert.equal(res.headers.location, '/x');
});

test('the nav renders prev and next with rel and escaped titles', async (t) => {
  const { page, get } = await setup(t);
  page('board', { title: 'Board & Co' });
  page('a', { tags: ['board'], title: 'A <one>', order: 1 });
  page('b', { tags: ['board'], title: 'B', order: 2 });
  page('c', { tags: ['board'], title: 'C', order: 3 });
  const res = await get('/board/b');
  assert.match(
    res.body,
    /<nav class="rkr-collection-nav"><a class="rkr-collection-back" href="\/board">Back to Board &amp; Co<\/a><a class="rkr-collection-prev" rel="prev" href="\/board\/a">A &lt;one&gt;<\/a><a class="rkr-collection-next" rel="next" href="\/board\/c">C<\/a><\/nav>\s*<\/article>/
  );
});
