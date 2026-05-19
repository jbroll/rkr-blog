// Portable SQLite archive for backup and restore.
//
// Archive schema (v1):
//   meta          — version, exported_at, generator
//   files         — all non-derivable on-disk content as BLOBs
//                   (content/posts/*.md, sidecars/*.json,
//                    originals/**.<ext>, config/site.json)
//   comments      — with post_slug + export_id instead of FK ints
//   users         — email, role, display_name (no id — reassigned)
//   allowed_emails — email, role, invited_at
//
// Excluded (fully derivable): bakes/, cache/, posts/tags/fts tables,
// sessions, oauth_tokens, oauth_accounts, jobs, applied_outbox.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { open } from './db.ts';
import { runReindex } from './post-index.ts';

const ARCHIVE_VERSION = '1';

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files (path TEXT PRIMARY KEY, data BLOB NOT NULL);
CREATE TABLE comments (
  export_id        INTEGER NOT NULL,
  post_slug        TEXT    NOT NULL,
  parent_export_id INTEGER NULL,
  wp_comment_id    INTEGER NULL,
  author_name      TEXT    NOT NULL,
  author_email     TEXT    NOT NULL,
  body             TEXT    NOT NULL,
  status           TEXT    NOT NULL,
  source           TEXT    NOT NULL,
  spam_score       REAL    NULL,
  spam_reason      TEXT    NULL,
  ip               TEXT    NULL,
  created_at       TEXT    NOT NULL,
  classified_at    TEXT    NULL
);
CREATE TABLE users (
  email        TEXT PRIMARY KEY,
  display_name TEXT,
  role         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE TABLE allowed_emails (
  email      TEXT PRIMARY KEY,
  role       TEXT NOT NULL,
  invited_at TEXT NOT NULL
);
`.trim();

export interface ExportStats {
  files: number;
  comments: number;
  users: number;
  invites: number;
}

export interface ImportStats {
  filesWritten: number;
  filesSkipped: number;
  comments: number;
  users: number;
  invites: number;
}

// ---- export ---------------------------------------------------------------

export function exportArchive(siteRoot: string, outPath: string): ExportStats {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const arc = open(outPath);
  arc.exec(SCHEMA);
  const insertMeta = arc.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  insertMeta.run('version', ARCHIVE_VERSION);
  insertMeta.run('exported_at', new Date().toISOString());
  insertMeta.run('generator', 'rkr-blog');

  const insertFile = arc.prepare('INSERT OR REPLACE INTO files (path, data) VALUES (?, ?)');
  let fileCount = 0;

  function addFile(rel: string, absPath: string): void {
    if (!fs.existsSync(absPath)) return;
    const data = fs.readFileSync(absPath);
    insertFile.run(rel, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    fileCount++;
  }

  // content/posts/*.md
  const postsDir = path.join(siteRoot, 'content', 'posts');
  if (fs.existsSync(postsDir)) {
    for (const f of fs.readdirSync(postsDir)) {
      if (f.endsWith('.md')) addFile(`content/posts/${f}`, path.join(postsDir, f));
    }
  }

  // sidecars/*.json (flat dir)
  const sidecarsDir = path.join(siteRoot, 'sidecars');
  if (fs.existsSync(sidecarsDir)) {
    for (const f of fs.readdirSync(sidecarsDir)) {
      if (f.endsWith('.json')) addFile(`sidecars/${f}`, path.join(sidecarsDir, f));
    }
  }

  // originals/<aa>/<bb>/<id>.<ext> (2-level sharded)
  const originalsDir = path.join(siteRoot, 'originals');
  if (fs.existsSync(originalsDir)) {
    for (const aa of fs.readdirSync(originalsDir)) {
      if (aa === '.tmp') continue;
      const aaDir = path.join(originalsDir, aa);
      if (!fs.statSync(aaDir).isDirectory()) continue;
      for (const bb of fs.readdirSync(aaDir)) {
        const bbDir = path.join(aaDir, bb);
        if (!fs.statSync(bbDir).isDirectory()) continue;
        for (const f of fs.readdirSync(bbDir)) {
          addFile(`originals/${aa}/${bb}/${f}`, path.join(bbDir, f));
        }
      }
    }
  }

  // config/site.json
  addFile('config/site.json', path.join(siteRoot, 'config', 'site.json'));

  // DB-only state: comments, users, allowed_emails
  const dbPath = path.join(siteRoot, 'data', 'site.db');
  if (!fs.existsSync(dbPath)) {
    arc.close();
    return { files: fileCount, comments: 0, users: 0, invites: 0 };
  }

  const db = open(dbPath);
  let commentCount = 0;
  let userCount = 0;
  let inviteCount = 0;

  try {
    const insertComment = arc.prepare(
      `INSERT INTO comments
         (export_id, post_slug, parent_export_id, wp_comment_id,
          author_name, author_email, body,
          status, source, spam_score, spam_reason, ip,
          created_at, classified_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const row of db
      .prepare<{
        id: number;
        slug: string;
        parent_id: number | null;
        wp_comment_id: number | null;
        author_name: string;
        author_email: string;
        body: string;
        status: string;
        source: string;
        spam_score: number | null;
        spam_reason: string | null;
        ip: string | null;
        created_at: string;
        classified_at: string | null;
      }>(
        `SELECT c.id, p.slug, c.parent_id, c.wp_comment_id,
                c.author_name, c.author_email, c.body,
                c.status, c.source, c.spam_score, c.spam_reason, c.ip,
                c.created_at, c.classified_at
         FROM comments c JOIN posts p ON c.post_id = p.id
         ORDER BY c.id`
      )
      .all()) {
      insertComment.run(
        row.id,
        row.slug,
        row.parent_id ?? null,
        row.wp_comment_id ?? null,
        row.author_name,
        row.author_email,
        row.body,
        row.status,
        row.source,
        row.spam_score ?? null,
        row.spam_reason ?? null,
        row.ip ?? null,
        row.created_at,
        row.classified_at ?? null
      );
      commentCount++;
    }

    const insertUser = arc.prepare(
      'INSERT OR REPLACE INTO users (email, display_name, role, created_at, last_seen_at) VALUES (?,?,?,?,?)'
    );
    for (const row of db
      .prepare<{
        email: string;
        display_name: string | null;
        role: string;
        created_at: string;
        last_seen_at: string | null;
      }>('SELECT email, display_name, role, created_at, last_seen_at FROM users')
      .all()) {
      insertUser.run(
        row.email,
        row.display_name ?? null,
        row.role,
        row.created_at,
        row.last_seen_at ?? null
      );
      userCount++;
    }

    const insertInvite = arc.prepare(
      'INSERT OR REPLACE INTO allowed_emails (email, role, invited_at) VALUES (?,?,?)'
    );
    for (const row of db
      .prepare<{ email: string; role: string; invited_at: string }>(
        'SELECT email, role, invited_at FROM allowed_emails'
      )
      .all()) {
      insertInvite.run(row.email, row.role, row.invited_at);
      inviteCount++;
    }
  } finally {
    db.close();
    arc.close();
  }

  return { files: fileCount, comments: commentCount, users: userCount, invites: inviteCount };
}

// ---- import ---------------------------------------------------------------

export function importArchive(
  siteRoot: string,
  archivePath: string,
  opts: { replace?: boolean } = {}
): ImportStats {
  const arc = open(archivePath);

  const versionRow = arc
    .prepare<{ value: string }>('SELECT value FROM meta WHERE key = ?')
    .get('version');
  if (!versionRow || versionRow.value !== ARCHIVE_VERSION) {
    arc.close();
    throw new Error(
      `importArchive: unsupported archive version ${String(versionRow?.value)} (expected ${ARCHIVE_VERSION})`
    );
  }

  // --- restore files to disk ---
  let written = 0;
  let skipped = 0;
  for (const row of arc
    .prepare<{ path: string; data: Uint8Array }>('SELECT path, data FROM files ORDER BY path')
    .all()) {
    const target = path.join(siteRoot, row.path.split('/').join(path.sep));
    if (!opts.replace && fs.existsSync(target)) {
      skipped++;
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeBlob(target, row.data);
    written++;
  }

  // --- rebuild posts/tags/fts index from restored markdown ---
  runReindex(siteRoot);

  // --- restore DB-only state ---
  const dbPath = path.join(siteRoot, 'data', 'site.db');
  const db = open(dbPath);

  let commentCount = 0;
  let userCount = 0;
  let inviteCount = 0;

  try {
    db.transaction(() => {
      if (opts.replace) {
        db.exec('DELETE FROM comments');
        db.exec('DELETE FROM users');
        db.exec('DELETE FROM allowed_emails');
      }

      const upsertUser = db.prepare(
        `INSERT INTO users (email, display_name, role, created_at, last_seen_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(email) DO UPDATE SET
           display_name = excluded.display_name,
           role         = excluded.role,
           last_seen_at = excluded.last_seen_at`
      );
      for (const row of arc
        .prepare<{
          email: string;
          display_name: string | null;
          role: string;
          created_at: string;
          last_seen_at: string | null;
        }>('SELECT email, display_name, role, created_at, last_seen_at FROM users')
        .all()) {
        upsertUser.run(
          row.email,
          row.display_name ?? null,
          row.role,
          row.created_at,
          row.last_seen_at ?? null
        );
        userCount++;
      }

      const upsertInvite = db.prepare(
        `INSERT INTO allowed_emails (email, role, invited_at) VALUES (?,?,?)
         ON CONFLICT(email) DO UPDATE SET role = excluded.role, invited_at = excluded.invited_at`
      );
      for (const row of arc
        .prepare<{ email: string; role: string; invited_at: string }>(
          'SELECT email, role, invited_at FROM allowed_emails'
        )
        .all()) {
        upsertInvite.run(row.email, row.role, row.invited_at);
        inviteCount++;
      }
    })();

    // Comments: resolve slug→post_id and export_id→new_id after reindex.
    const slugToPostId = new Map<string, number>();
    for (const row of db
      .prepare<{ id: number; slug: string }>('SELECT id, slug FROM posts')
      .all()) {
      slugToPostId.set(row.slug, row.id);
    }

    const exportIdToNewId = new Map<number, number>();
    const insertComment = db.prepare(
      `INSERT INTO comments
         (post_id, parent_id, wp_comment_id,
          author_name, author_email, body,
          status, source, spam_score, spam_reason, ip,
          created_at, classified_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const hasWpId = db.prepare<{ c: number }>(
      'SELECT COUNT(*) AS c FROM comments WHERE wp_comment_id = ?'
    );
    const hasDupe = db.prepare<{ c: number }>(
      'SELECT COUNT(*) AS c FROM comments WHERE post_id=? AND author_email=? AND created_at=?'
    );

    for (const row of arc
      .prepare<{
        export_id: number;
        post_slug: string;
        parent_export_id: number | null;
        wp_comment_id: number | null;
        author_name: string;
        author_email: string;
        body: string;
        status: string;
        source: string;
        spam_score: number | null;
        spam_reason: string | null;
        ip: string | null;
        created_at: string;
        classified_at: string | null;
      }>('SELECT * FROM comments ORDER BY export_id')
      .all()) {
      const postId = slugToPostId.get(row.post_slug);
      if (postId === undefined) continue; // post not found after reindex

      if (!opts.replace) {
        // merge: skip duplicates
        if (row.wp_comment_id !== null) {
          const { c } = hasWpId.get(row.wp_comment_id) as { c: number };
          if (c > 0) {
            exportIdToNewId.set(row.export_id, -1);
            continue;
          }
        } else {
          const { c } = hasDupe.get(postId, row.author_email, row.created_at) as { c: number };
          if (c > 0) {
            exportIdToNewId.set(row.export_id, -1);
            continue;
          }
        }
      }

      const parentId =
        row.parent_export_id !== null ? (exportIdToNewId.get(row.parent_export_id) ?? null) : null;
      const result = insertComment.run(
        postId,
        parentId === -1 ? null : (parentId ?? null),
        row.wp_comment_id ?? null,
        row.author_name,
        row.author_email,
        row.body,
        row.status,
        row.source,
        row.spam_score ?? null,
        row.spam_reason ?? null,
        row.ip ?? null,
        row.created_at,
        row.classified_at ?? null
      );
      exportIdToNewId.set(row.export_id, result.lastInsertRowid);
      commentCount++;
    }
  } finally {
    db.close();
    arc.close();
  }

  return {
    filesWritten: written,
    filesSkipped: skipped,
    comments: commentCount,
    users: userCount,
    invites: inviteCount
  };
}

// ---- helpers --------------------------------------------------------------

function writeBlob(target: string, data: Uint8Array): void {
  const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
