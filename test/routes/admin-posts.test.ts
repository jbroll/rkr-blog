import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { buildApp } from '../../src/server.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-admin-posts-'));
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
  // Pass db so public routes (incl. GET /:slug) register; startWorker:false
  // because we don't render anything in this test.
  const db = open(path.join(root, 'data', 'site.db'));
  t.after(() => db.close());
  const app = await buildApp({ siteRoot: root, db, startWorker: false });
  t.after(() => app.close());
  return { root, app };
}

const SAMPLE_MD = 'Hello **world**\n\n::image{#abc123def4567890 alt="cap"}\n';

test('POST /admin/posts saves a new post and reindexes (visible at /:slug)', async (t) => {
  const { root, app } = await setup(t);

  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'hello',
      title: 'Hello world',
      status: 'published',
      date: '2026-05-06T14:00:00Z',
      markdown: SAMPLE_MD
    }
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<{ slug: string; inserted: boolean }>();
  assert.equal(body.slug, 'hello');
  assert.equal(body.inserted, true);

  // The .md file landed on disk with the right frontmatter and body.
  const onDisk = fs.readFileSync(path.join(root, 'content', 'posts', 'hello.md'), 'utf8');
  assert.match(onDisk, /^---\ntitle: Hello world\nslug: hello\n/);
  assert.match(onDisk, /Hello \*\*world\*\*/);
  assert.match(onDisk, /::image\{#abc123def4567890 alt="cap"\}/);

  // Reindexed → /hello returns 200 (uses the public route from Step 5).
  const page = await app.inject({ method: 'GET', url: '/hello' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<title>Hello world — [^<]+<\/title>/);
});

test('POST /admin/posts accepts a body that opens with a horizontal rule', async (t) => {
  // Regression: proseToMarkdown emits `* * *` (not `---`) for a leading
  // horizontal rule precisely so the editor's own valid output isn't
  // rejected by the frontmatter-smuggling guard. The guard still has
  // to recognise that `* * *` is not a delimiter.
  const { app } = await setup(t);

  const res = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'starts-with-rule',
      title: 'Rule first',
      status: 'draft',
      markdown: '* * *\n\nafter the rule\n'
    }
  });
  assert.equal(res.statusCode, 200, res.body);
});

test('POST /admin/posts overwrites an existing post (inserted=false)', async (t) => {
  const { app } = await setup(t);

  const payload = {
    slug: 'twice',
    title: 'First take',
    status: 'draft',
    markdown: 'v1\n'
  };
  const r1 = await app.inject({ method: 'POST', url: '/admin/posts', payload });
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.json<{ inserted: boolean }>().inserted, true);

  const r2 = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { ...payload, title: 'Second take' }
  });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json<{ inserted: boolean }>().inserted, false);
});

// Spec-offline §6: when the client's X-Rkr-Last-Synced-At is older
// than the server's mtime for the post, the save is refused with
// 409 post-superseded. The client surfaces discard / force-overwrite
// (force re-POSTs without the header).
test('POST /admin/posts: stale X-Rkr-Last-Synced-At returns 409 post-superseded', async (t) => {
  const { root, app } = await setup(t);

  const payload = {
    slug: 'concurrent',
    title: 'v1',
    status: 'draft' as const,
    markdown: 'first\n'
  };
  const first = await app.inject({ method: 'POST', url: '/admin/posts', payload });
  assert.equal(first.statusCode, 200);

  // Pretend a competing device wrote a NEWER version: bump the file
  // mtime forward by 5s. Now the original client's "lastSyncedAt =
  // before-original-write" header is older than the server's mtime.
  const filePath = path.join(root, 'content', 'posts', 'concurrent.md');
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(filePath, future, future);
  const staleClientTs = new Date(Date.now() - 60_000).toISOString();

  const conflict = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: { 'x-rkr-last-synced-at': staleClientTs },
    payload: { ...payload, title: 'v2 stale' }
  });
  assert.equal(conflict.statusCode, 409);
  const body = conflict.json<{
    error: string;
    slug: string;
    serverUpdatedAt: string;
    clientLastSyncedAt: string;
  }>();
  assert.equal(body.error, 'post-superseded');
  assert.equal(body.slug, 'concurrent');
  assert.equal(body.clientLastSyncedAt, staleClientTs);
  assert.ok(body.serverUpdatedAt > staleClientTs);

  // The .md file on disk wasn't overwritten — the conflict halted
  // the write before it landed.
  const onDisk = fs.readFileSync(filePath, 'utf8');
  assert.match(onDisk, /title: v1/);
});

// Same shape as above but the header matches the server's mtime —
// the save proceeds. This is the "no concurrent write happened"
// happy path.
test('POST /admin/posts: fresh X-Rkr-Last-Synced-At permits overwrite', async (t) => {
  const { root, app } = await setup(t);

  const payload = {
    slug: 'fresh-sync',
    title: 'v1',
    status: 'draft' as const,
    markdown: 'first\n'
  };
  await app.inject({ method: 'POST', url: '/admin/posts', payload });

  const filePath = path.join(root, 'content', 'posts', 'fresh-sync.md');
  const serverMtime = new Date(fs.statSync(filePath).mtimeMs).toISOString();

  const ok = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: { 'x-rkr-last-synced-at': serverMtime },
    payload: { ...payload, title: 'v2 in-sync' }
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const onDisk = fs.readFileSync(filePath, 'utf8');
  assert.match(onDisk, /title: v2 in-sync/);
});

// Force-overwrite path (§6): when the client decides to clobber,
// they re-POST without the X-Rkr-Last-Synced-At header. The server
// accepts unconditionally — even though the file is newer.
// Regression: the original `serverUpdatedAt > lastSyncedAt` byte-
// string compare let a future-dated header bypass the guard
// (lexicographic compare puts any real ISO timestamp behind
// "9999-..."). The fix parses + clamps the client's claim to now.
test('POST /admin/posts: future-dated X-Rkr-Last-Synced-At still 409s (clamped)', async (t) => {
  const { root, app } = await setup(t);

  const payload = {
    slug: 'future-dated',
    title: 'v1',
    status: 'draft' as const,
    markdown: 'first\n'
  };
  await app.inject({ method: 'POST', url: '/admin/posts', payload });
  // Bump the file forward so the server's mtime is a few ms past
  // "now" — without the clamp, a 9999-... header would compare
  // greater than ANY real mtime and the guard would no-op.
  const filePath = path.join(root, 'content', 'posts', 'future-dated.md');
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(filePath, future, future);

  const conflict = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: { 'x-rkr-last-synced-at': '9999-12-31T23:59:59.999Z' },
    payload: { ...payload, title: 'v2 future-claimed' }
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json<{ error: string }>().error, 'post-superseded');
});

// Regression: a non-ISO string slipped through `typeof === 'string'`
// and lex compared as smaller than the server's ISO timestamp,
// silently accepting the write. The fix rejects with 400.
test('POST /admin/posts: malformed X-Rkr-Last-Synced-At returns 400', async (t) => {
  const { app } = await setup(t);
  const payload = {
    slug: 'malformed',
    title: 'v1',
    status: 'draft' as const,
    markdown: 'first\n'
  };
  await app.inject({ method: 'POST', url: '/admin/posts', payload });
  const bad = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    headers: { 'x-rkr-last-synced-at': 'banana' },
    payload: { ...payload, title: 'v2' }
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json<{ error: string }>().error, /ISO-8601/);
});

test('POST /admin/posts: force-overwrite (no header) bypasses the conflict guard', async (t) => {
  const { root, app } = await setup(t);

  const payload = {
    slug: 'force-overwrite',
    title: 'v1',
    status: 'draft' as const,
    markdown: 'first\n'
  };
  await app.inject({ method: 'POST', url: '/admin/posts', payload });
  const filePath = path.join(root, 'content', 'posts', 'force-overwrite.md');
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(filePath, future, future);

  const ok = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { ...payload, title: 'v2 forced' }
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const onDisk = fs.readFileSync(filePath, 'utf8');
  assert.match(onDisk, /title: v2 forced/);
});

// Status flip via the per-row select on /admin/posts. The form posts
// to /admin/posts/:slug/status; the server rewrites just the
// `status:` line in the file's frontmatter and reindexes.
test('POST /admin/posts/:slug/status flips the frontmatter status line', async (t) => {
  const { root, app } = await setup(t);

  const seed = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { slug: 'flip-me', title: 'Flip me', status: 'draft', markdown: 'body\n' }
  });
  assert.equal(seed.statusCode, 200);
  const filePath = path.join(root, 'content', 'posts', 'flip-me.md');
  assert.match(fs.readFileSync(filePath, 'utf8'), /^status: draft$/m);

  const flip = await app.inject({
    method: 'POST',
    url: '/admin/posts/flip-me/status',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'status=published'
  });
  assert.equal(flip.statusCode, 303);
  assert.equal(flip.headers.location, '/admin/posts');
  assert.match(fs.readFileSync(filePath, 'utf8'), /^status: published$/m);

  // Reindex ran — /flip-me is now publicly visible.
  const page = await app.inject({ method: 'GET', url: '/flip-me' });
  assert.equal(page.statusCode, 200);
});

test('POST /admin/posts/:slug/status: 400 on bad slug + bad status, 404 on unknown slug', async (t) => {
  const { app } = await setup(t);

  const badSlug = await app.inject({
    method: 'POST',
    url: '/admin/posts/has spaces/status',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'status=published'
  });
  assert.equal(badSlug.statusCode, 400);
  assert.match(badSlug.json<{ error: string }>().error, /slug/);

  const badStatus = await app.inject({
    method: 'POST',
    url: '/admin/posts/x/status',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'status=trash'
  });
  assert.equal(badStatus.statusCode, 400);
  assert.match(badStatus.json<{ error: string }>().error, /status/);

  const missing = await app.inject({
    method: 'POST',
    url: '/admin/posts/never-existed/status',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'status=published'
  });
  assert.equal(missing.statusCode, 404);
});

// No-op flip: setting status to its current value still 303s but
// skips the disk write + reindex. Covers the early-return branch.
test('POST /admin/posts/:slug/status: no-op when status already matches', async (t) => {
  const { root, app } = await setup(t);
  await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { slug: 'noop', title: 'noop', status: 'draft', markdown: 'body\n' }
  });
  const filePath = path.join(root, 'content', 'posts', 'noop.md');
  const mtimeBefore = fs.statSync(filePath).mtimeMs;
  // Cross a tick so the assertion below would catch a stray write.
  await new Promise((r) => setTimeout(r, 10));

  const r = await app.inject({
    method: 'POST',
    url: '/admin/posts/noop/status',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'status=draft'
  });
  assert.equal(r.statusCode, 303);
  assert.equal(fs.statSync(filePath).mtimeMs, mtimeBefore);
});

// Frontmatter without a status: line is a legitimate edge case
// (older imports, hand-edited posts). The flip endpoint inserts
// `status: <new>` rather than 400-ing out.
test('POST /admin/posts/:slug/status: inserts a status line when missing', async (t) => {
  const { root, app } = await setup(t);
  const postsDir = path.join(root, 'content', 'posts');
  fs.mkdirSync(postsDir, { recursive: true });
  // Hand-rolled file with no status — bypass POST /admin/posts which
  // would always write one.
  fs.writeFileSync(
    path.join(postsDir, 'no-status.md'),
    '---\ntitle: No status\nslug: no-status\ndate: 2026-01-01T00:00:00Z\n---\n\nbody\n'
  );
  const r = await app.inject({
    method: 'POST',
    url: '/admin/posts/no-status/status',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'status=published'
  });
  assert.equal(r.statusCode, 303);
  const onDisk = fs.readFileSync(path.join(postsDir, 'no-status.md'), 'utf8');
  assert.match(onDisk, /^status: published$/m);
});

// Malformed frontmatter (no opening fence) returns 400 — we don't
// invent a fence for a file we can't safely round-trip.
test('POST /admin/posts/:slug/status: 400 on file missing frontmatter open', async (t) => {
  const { root, app } = await setup(t);
  const postsDir = path.join(root, 'content', 'posts');
  fs.mkdirSync(postsDir, { recursive: true });
  fs.writeFileSync(path.join(postsDir, 'malformed.md'), 'just body, no frontmatter\n');
  const r = await app.inject({
    method: 'POST',
    url: '/admin/posts/malformed/status',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'status=published'
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.json<{ error: string }>().error, /frontmatter/);
});

// Save-handler precedence: when the editor save body omits status,
// the server preserves the existing post's status. A regression here
// would silently flip a published post to draft on every save.
test('POST /admin/posts: omitted status preserves the existing file status', async (t) => {
  const { root, app } = await setup(t);

  const seed = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { slug: 'preserve', title: 'v1', status: 'published', markdown: 'v1\n' }
  });
  assert.equal(seed.statusCode, 200);

  const overwrite = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { slug: 'preserve', title: 'v2', markdown: 'v2\n' }
  });
  assert.equal(overwrite.statusCode, 200);
  const onDisk = fs.readFileSync(path.join(root, 'content', 'posts', 'preserve.md'), 'utf8');
  assert.match(onDisk, /^status: published$/m);
});

// Inserting a brand-new post with no status defaults to 'draft' so a
// stray API caller doesn't accidentally publish.
test('POST /admin/posts: omitted status on insert defaults to draft', async (t) => {
  const { root, app } = await setup(t);
  const r = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { slug: 'fresh', title: 'fresh', markdown: 'body\n' }
  });
  assert.equal(r.statusCode, 200);
  const onDisk = fs.readFileSync(path.join(root, 'content', 'posts', 'fresh.md'), 'utf8');
  assert.match(onDisk, /^status: draft$/m);
});

test('POST /admin/posts rejects bad slug / missing title / missing markdown', async (t) => {
  const { app } = await setup(t);

  const bad1 = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { slug: 'has spaces', title: 'X', status: 'draft', markdown: '' }
  });
  assert.equal(bad1.statusCode, 400);
  assert.match(bad1.json<{ error: string }>().error, /slug/);

  const bad2 = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { slug: 'ok', title: '', status: 'draft', markdown: '' }
  });
  assert.equal(bad2.statusCode, 400);
  assert.match(bad2.json<{ error: string }>().error, /title/);

  const bad3 = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { slug: 'ok', title: 'X', status: 'draft', markdown: 42 }
  });
  assert.equal(bad3.statusCode, 400);
  assert.match(bad3.json<{ error: string }>().error, /markdown/);

  // Reject markdown that opens with a YAML frontmatter delimiter — it
  // would smuggle a second frontmatter block past the one we control.
  const bad4 = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'ok',
      title: 'X',
      status: 'draft',
      markdown: '---\ntitle: hijack\n---\n\nbody\n'
    }
  });
  assert.equal(bad4.statusCode, 400);
  assert.match(bad4.json<{ error: string }>().error, /frontmatter/);

  // CR-only line endings must also be caught — a sloppy `\s\n` regex
  // would have let `---\rkey: x\r---` slip through.
  const badCr = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'ok',
      title: 'X',
      status: 'draft',
      markdown: '---\rtitle: hijack\r---\r\nbody\n'
    }
  });
  assert.equal(badCr.statusCode, 400);
  assert.match(badCr.json<{ error: string }>().error, /frontmatter/);

  // `---` followed by prose (no key:value, no closing `---`) is NOT
  // frontmatter — the looksLikeFrontmatterDelimiter heuristic returns
  // false for the first non-empty line that's neither `---` nor a yaml
  // mapping. Accept the body as a normal post.
  const proseAfterDashes = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'prose-dashes',
      title: 'Prose with dashes',
      status: 'draft',
      markdown: '---\nplain prose line that is not yaml\nmore prose\n'
    }
  });
  assert.equal(proseAfterDashes.statusCode, 200, proseAfterDashes.body);

  // `---` with only whitespace lines after also isn't frontmatter (the
  // for-loop completes without ever finding a delimiter or mapping).
  const proseEmptyAfter = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: {
      slug: 'prose-empty',
      title: 'Empty after dashes',
      status: 'draft',
      markdown: '---\n   \n\n   \n'
    }
  });
  assert.equal(proseEmptyAfter.statusCode, 200, proseEmptyAfter.body);

  // Slug length cap: 200-char slug is rejected even though every char is
  // a valid kebab-case character. Without this, a 50KB slug would be
  // accepted, written to disk as a filename, and indexed.
  const longSlug = 'a'.repeat(200);
  const bad5 = await app.inject({
    method: 'POST',
    url: '/admin/posts',
    payload: { slug: longSlug, title: 'X', status: 'draft', markdown: '' }
  });
  assert.equal(bad5.statusCode, 400);
  assert.match(bad5.json<{ error: string }>().error, /slug/);
});
