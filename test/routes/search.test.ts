import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import type { Db } from '../../src/lib/db.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { runReindex } from '../../src/lib/post-index.ts';
import { buildApp } from '../../src/server.ts';

function seed(
  root: string,
  file: string,
  slug: string,
  title: string,
  status: string,
  body: string
): void {
  fs.writeFileSync(
    path.join(root, 'content', 'posts', file),
    `---\nslug: ${slug}\ntitle: ${title}\nstatus: ${status}\ndate: 2026-05-01\n---\n\n${body}\n`
  );
}

async function setup(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-search-'));
  for (const s of ['content/posts', 'data']) {
    fs.mkdirSync(path.join(root, s), { recursive: true });
  }
  seed(root, 'pub.md', 'pub', 'Rust Async', 'published', 'tokio runtime details here');
  seed(root, 'draft.md', 'draft', 'Secret Draft', 'draft', 'tokio draft only');
  runReindex(root);
  const db = open(path.join(root, 'data', 'site.db'));
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, root };
}

test('GET /search with no q renders the prompt state', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/search' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Type a query/);
});

test('anonymous search returns published hits with a <mark> snippet, not drafts', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({ method: 'GET', url: '/search?q=tokio' });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<a href="\/pub">Rust Async<\/a>/);
  assert.match(res.body, /<mark>/);
  assert.doesNotMatch(res.body, /Secret Draft/);
});

test('query is HTML-escaped (no XSS via q)', async (t) => {
  const { app } = await setup(t);
  const res = await app.inject({
    method: 'GET',
    url: `/search?q=${encodeURIComponent('<script>x</script>')}`
  });
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.body, /<script>x<\/script>/);
});

test('search returns empty 200 when FTS table is not migrated (graceful degrade)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-search-nofts-'));
  for (const s of ['content/posts', 'data']) {
    fs.mkdirSync(path.join(root, s), { recursive: true });
  }
  // Create db with only migrations 001-005 — no posts_fts table (migration 006).
  const db = open(path.join(root, 'data', 'site.db'));
  const migrationsDir = new URL('../../src/migrations', import.meta.url).pathname;
  const allMigrations = (await import('../../src/lib/migrate.ts')).listMigrations(migrationsDir);
  const limitedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-mig-'));
  for (const m of allMigrations.filter((m) => m.version < 6)) {
    fs.copyFileSync(m.full, path.join(limitedDir, m.filename));
  }
  migrate(db, limitedDir);
  fs.rmSync(limitedDir, { recursive: true, force: true });

  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const res = await app.inject({ method: 'GET', url: '/search?q=tokio' });
  assert.equal(res.statusCode, 200, 'should degrade to empty results, not 500');
  // No error logged, no crash — just the empty search page
  assert.doesNotMatch(res.body, /Secret Draft/);
});

test('search self-heals: ftsAvailable=false flips true after runtime FTS creation', async (t) => {
  // Build app against a db that starts WITHOUT posts_fts (migrations 001-005 only).
  // Verify graceful empty (cached false). Then create+populate FTS via runReindex
  // against the same db dir. Then verify the next /search request returns real hits
  // WITHOUT restarting the server — proving the per-request re-probe flips the cache.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-search-heal-'));
  for (const s of ['content/posts', 'data']) {
    fs.mkdirSync(path.join(root, s), { recursive: true });
  }
  seed(root, 'pub.md', 'pub', 'Rust Async', 'published', 'tokio runtime details here');

  const db = open(path.join(root, 'data', 'site.db'));
  const migrationsDir = new URL('../../src/migrations', import.meta.url).pathname;
  const allMigrations = (await import('../../src/lib/migrate.ts')).listMigrations(migrationsDir);
  const limitedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-mig-heal-'));
  for (const m of allMigrations.filter((m) => m.version < 6)) {
    fs.copyFileSync(m.full, path.join(limitedDir, m.filename));
  }
  migrate(db, limitedDir);
  fs.rmSync(limitedDir, { recursive: true, force: true });

  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(async () => {
    await app.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // PRE: posts_fts does not exist — ftsAvailable cached false — graceful empty 200.
  const pre = await app.inject({ method: 'GET', url: '/search?q=tokio' });
  assert.equal(pre.statusCode, 200, 'pre: should be 200 graceful empty');
  assert.doesNotMatch(pre.body, /Rust Async/, 'pre: should return no results');

  // Simulate runtime reindex: creates+populates posts_fts on the same db.
  runReindex(root);

  // POST: same server process, same ftsAvailable closure — re-probe picks up FTS.
  const post = await app.inject({ method: 'GET', url: '/search?q=tokio' });
  assert.equal(post.statusCode, 200, 'post: should still be 200');
  assert.match(post.body, /Rust Async/, 'post: should now return results after FTS creation');
});

test('search propagates unexpected DB query errors (not silent empty)', async (t) => {
  // Build a fresh app with a broken-query db that simulates a corrupt FTS index.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-search-broken-'));
  for (const s of ['content/posts', 'data']) {
    fs.mkdirSync(path.join(root, s), { recursive: true });
  }
  // runReindex creates the FTS table (migration 006 is included).
  runReindex(root);
  const realDb = open(path.join(root, 'data', 'site.db'));

  // Proxy: probe query (SELECT 1 FROM posts_fts LIMIT 0) succeeds so ftsAvailable=true,
  // but the real MATCH query (contains 'MATCH') throws an unexpected error.
  const brokenDb: Db = {
    prepare<TRow = unknown>(sql: string) {
      const stmt = realDb.prepare<TRow>(sql);
      if (sql.includes('MATCH')) {
        return {
          run: (..._params) => stmt.run(),
          get: (..._params) => {
            throw new Error('index corrupted');
          },
          all: (..._params) => {
            throw new Error('index corrupted');
          },
          iterate: (..._params) => stmt.iterate()
        };
      }
      return stmt;
    },
    exec: (sql: string) => realDb.exec(sql),
    transaction: realDb.transaction.bind(realDb),
    pragma: realDb.pragma.bind(realDb),
    close: () => realDb.close()
  };

  const brokenApp = await buildApp({ siteRoot: root, db: brokenDb, startWorker: false });
  t.after(async () => {
    await brokenApp.close();
    realDb.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const res = await brokenApp.inject({ method: 'GET', url: '/search?q=tokio' });
  // Must NOT be a silent empty-results 200 — the global error handler returns 500
  // with security headers set.
  assert.notEqual(res.statusCode, 200, 'unexpected DB error must not produce silent empty 200');
  assert.equal(res.statusCode, 500, 'unexpected DB error should propagate as 500');
  assert.equal(
    res.headers['x-content-type-options'],
    'nosniff',
    'global error handler sets security headers'
  );
});
