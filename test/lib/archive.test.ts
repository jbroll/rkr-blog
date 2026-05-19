import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import sharp from 'sharp';

import { exportArchive, importArchive } from '../../src/lib/archive.ts';
import { insertWebComment } from '../../src/lib/comments.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';
import { ingestStream } from '../../src/lib/originals.ts';
import { runReindex } from '../../src/lib/post-index.ts';
import { inviteEmail, listInvites } from '../../src/lib/users.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-archive-'));
  for (const sub of ['content/posts', 'data', 'sidecars', 'originals', 'config', 'cache/img']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function makeJpeg() {
  return sharp({
    create: { width: 80, height: 60, channels: 3, background: { r: 40, g: 80, b: 120 } }
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

function writePost(
  root: string,
  filename: string,
  slug: string,
  title: string,
  body = 'body text'
): void {
  fs.writeFileSync(
    path.join(root, 'content', 'posts', filename),
    `---\nslug: ${slug}\ntitle: ${title}\nstatus: published\ndate: 2026-01-15T12:00:00Z\n---\n\n${body}\n`
  );
}

// ---- migration 008 --------------------------------------------------------

test('migration 008: invited_by column removed from allowed_emails', () => {
  const dbPath = path.join(os.tmpdir(), `rkr-migration-008-${Date.now()}.db`);
  try {
    const db = open(dbPath);
    migrate(db);
    // invited_by column should not exist — SELECT would include it if present
    const cols = db
      .prepare<{ name: string }>(`PRAGMA table_info(allowed_emails)`)
      .all()
      .map((r) => r.name);
    assert.ok(!cols.includes('invited_by'), `invited_by still in schema: ${cols.join(', ')}`);
    // inviteEmail still works without invited_by
    inviteEmail(db, 'test@example.com', 'editor');
    const invites = listInvites(db);
    assert.equal(invites.length, 1);
    assert.equal(invites[0]?.email, 'test@example.com');
    db.close();
  } finally {
    fs.rmSync(dbPath, { force: true });
  }
});

// ---- round-trip -----------------------------------------------------------

test('export then import round-trip restores all content', async (t) => {
  const src = freshSiteRoot(t);
  const dst = freshSiteRoot(t);
  const arcPath = path.join(os.tmpdir(), `rkr-arc-${Date.now()}.sqlite`);
  t.after(() => fs.rmSync(arcPath, { force: true }));

  // 1. plant a post + config
  writePost(src, '2026-01-15-hello.md', 'hello', 'Hello World', 'Some body.');
  fs.writeFileSync(path.join(src, 'config', 'site.json'), JSON.stringify({ title: 'My Blog' }));

  // 2. ingest an image
  const { id: imgId } = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: src,
    source: { kind: 'upload', originalName: 'photo.jpg' },
    passthrough: true
  });

  // 3. reindex to create DB + post rows
  runReindex(src);

  // 4. add a comment + reply via the DB
  const db = open(path.join(src, 'data', 'site.db'));
  const post = db.prepare<{ id: number }>('SELECT id FROM posts WHERE slug = ?').get('hello');
  assert.ok(post, 'post should be indexed');
  const cid = insertWebComment(db, {
    postId: post.id,
    parentId: null,
    authorName: 'Alice',
    authorEmail: 'alice@example.com',
    body: 'Great post!',
    ip: '1.2.3.4'
  });
  // publish it so a reply can target it
  db.prepare('UPDATE comments SET status = ? WHERE id = ?').run('published', cid);
  const replyId = insertWebComment(db, {
    postId: post.id,
    parentId: cid,
    authorName: 'Bob',
    authorEmail: 'bob@example.com',
    body: 'Agreed!',
    ip: null
  });

  // 5. add a user + invite
  db.prepare(`INSERT INTO users (email, display_name, role, created_at) VALUES (?,?,?,?)`).run(
    'owner@example.com',
    'Owner',
    'owner',
    '2026-01-01T00:00:00Z'
  );
  inviteEmail(db, 'editor@example.com', 'editor');
  db.close();

  // 6. export
  const stats = exportArchive(src, arcPath);
  assert.ok(stats.files >= 3, `expected ≥3 files, got ${stats.files}`); // post + image + sidecar
  assert.equal(stats.comments, 2);
  assert.equal(stats.users, 1);
  assert.equal(stats.invites, 1);

  // 7. import into fresh site
  const iStats = importArchive(dst, arcPath);
  assert.ok(iStats.filesWritten >= 3);
  assert.equal(iStats.comments, 2);
  assert.equal(iStats.users, 1);
  assert.equal(iStats.invites, 1);

  // 8. verify markdown restored
  assert.ok(
    fs.existsSync(path.join(dst, 'content', 'posts', '2026-01-15-hello.md')),
    'post markdown restored'
  );

  // 9. verify original byte-equal
  const srcOrig = findOriginal(src, imgId);
  const dstOrig = findOriginal(dst, imgId);
  assert.ok(dstOrig, 'original restored to dst');
  assert.deepEqual(fs.readFileSync(srcOrig), fs.readFileSync(dstOrig), 'original bytes identical');

  // 10. verify sidecar restored
  assert.ok(fs.existsSync(path.join(dst, 'sidecars', `${imgId}.json`)), 'sidecar restored');

  // 11. verify config restored
  const cfg = JSON.parse(fs.readFileSync(path.join(dst, 'config', 'site.json'), 'utf8')) as {
    title: string;
  };
  assert.equal(cfg.title, 'My Blog');

  // 12. verify DB state: post + comments + user + invite
  const ddb = open(path.join(dst, 'data', 'site.db'));
  const dPost = ddb
    .prepare<{ id: number; slug: string }>('SELECT id, slug FROM posts WHERE slug = ?')
    .get('hello');
  assert.ok(dPost, 'post indexed in dst');

  const comments = ddb
    .prepare<{ id: number; parent_id: number | null; author_name: string }>(
      'SELECT id, parent_id, author_name FROM comments WHERE post_id = ? ORDER BY id'
    )
    .all(dPost.id);
  assert.equal(comments.length, 2);
  assert.equal(comments[0]?.author_name, 'Alice');
  assert.equal(comments[0]?.parent_id, null);
  assert.equal(comments[1]?.author_name, 'Bob');
  assert.equal(comments[1]?.parent_id, comments[0]?.id, 'reply parent_id re-linked correctly');

  const users = ddb.prepare<{ email: string }>('SELECT email FROM users').all();
  assert.equal(users.length, 1);
  assert.equal(users[0]?.email, 'owner@example.com');

  const invites = listInvites(ddb);
  assert.equal(invites.length, 1);
  assert.equal(invites[0]?.email, 'editor@example.com');
  ddb.close();

  void replyId; // used above via comments check
});

// ---- merge behaviour -------------------------------------------------------

test('import merge skips existing files and comments', async (t) => {
  const src = freshSiteRoot(t);
  const dst = freshSiteRoot(t);
  const arcPath = path.join(os.tmpdir(), `rkr-arc-merge-${Date.now()}.sqlite`);
  t.after(() => fs.rmSync(arcPath, { force: true }));

  writePost(src, '2026-01-15-hello.md', 'hello', 'Hello');
  runReindex(src);
  const db = open(path.join(src, 'data', 'site.db'));
  const post = db.prepare<{ id: number }>('SELECT id FROM posts WHERE slug = ?').get('hello')!;
  insertWebComment(db, {
    postId: post.id,
    parentId: null,
    authorName: 'A',
    authorEmail: 'a@x.com',
    body: 'hi',
    ip: null
  });
  db.close();

  exportArchive(src, arcPath);

  // plant a different file in dst before importing
  const mdPath = path.join(dst, 'content', 'posts', '2026-01-15-hello.md');
  fs.writeFileSync(
    mdPath,
    '---\nslug: hello\ntitle: Local Version\nstatus: published\ndate: 2026-01-15T12:00:00Z\n---\n\nbody\n'
  );

  const iStats = importArchive(dst, arcPath); // merge (default)
  assert.ok(iStats.filesSkipped >= 1, 'existing markdown skipped');

  // local file untouched
  const content = fs.readFileSync(mdPath, 'utf8');
  assert.ok(content.includes('Local Version'), 'existing file not overwritten in merge mode');
});

// ---- replace behaviour -----------------------------------------------------

test('import replace overwrites files and wipes DB tables', async (t) => {
  const src = freshSiteRoot(t);
  const dst = freshSiteRoot(t);
  const arcPath = path.join(os.tmpdir(), `rkr-arc-replace-${Date.now()}.sqlite`);
  t.after(() => fs.rmSync(arcPath, { force: true }));

  writePost(src, '2026-01-15-hello.md', 'hello', 'Hello');
  runReindex(src);
  const sdb = open(path.join(src, 'data', 'site.db'));
  inviteEmail(sdb, 'archive-invite@example.com', 'editor');
  sdb.close();

  exportArchive(src, arcPath);

  // pre-populate dst with a different invite
  writePost(dst, '2026-01-15-hello.md', 'hello', 'Local');
  runReindex(dst);
  const ddb = open(path.join(dst, 'data', 'site.db'));
  inviteEmail(ddb, 'local-invite@example.com', 'owner');
  ddb.close();

  importArchive(dst, arcPath, { replace: true });

  const rdb = open(path.join(dst, 'data', 'site.db'));
  const invites = listInvites(rdb);
  rdb.close();

  const emails = invites.map((i) => i.email);
  assert.ok(emails.includes('archive-invite@example.com'), 'archive invite restored');
  assert.ok(!emails.includes('local-invite@example.com'), 'local invite wiped by replace');
});

// ---- originals never deleted in replace mode --------------------------------

test('import replace never deletes existing originals', async (t) => {
  const src = freshSiteRoot(t);
  const dst = freshSiteRoot(t);
  const arcPath = path.join(os.tmpdir(), `rkr-arc-nodelete-${Date.now()}.sqlite`);
  t.after(() => fs.rmSync(arcPath, { force: true }));

  writePost(src, '2026-01-15-post.md', 'post', 'Post');
  exportArchive(src, arcPath);

  // plant an original in dst before replace-import
  const { id: extraId } = await ingestStream({
    stream: Readable.from([await makeJpeg()]),
    siteRoot: dst,
    source: { kind: 'upload', originalName: 'extra.jpg' },
    passthrough: true
  });

  importArchive(dst, arcPath, { replace: true });

  // extra original must still be on disk
  assert.ok(findOriginal(dst, extraId), 'existing original not deleted by replace');
});

// ---- bad archive -----------------------------------------------------------

test('importArchive rejects wrong version', (t) => {
  const root = freshSiteRoot(t);
  const arcPath = path.join(os.tmpdir(), `rkr-arc-bad-${Date.now()}.sqlite`);
  t.after(() => fs.rmSync(arcPath, { force: true }));

  const db = open(arcPath);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.prepare('INSERT INTO meta (key, value) VALUES (?,?)').run('version', '99');
  db.close();

  assert.throws(() => importArchive(root, arcPath), /unsupported archive version/);
});

// ---- helper ---------------------------------------------------------------

function findOriginal(siteRoot: string, id: string): string {
  const aa = id.slice(0, 2);
  const bb = id.slice(2, 4);
  const dir = path.join(siteRoot, 'originals', aa, bb);
  if (!fs.existsSync(dir)) return '';
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(id)) return path.join(dir, f);
  }
  return '';
}
