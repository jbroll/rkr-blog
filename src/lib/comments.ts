// Comment persistence. The only module that issues SQL against the
// `comments` table (migration 004). One-level threading is enforced
// here: a reply's parent must itself be top-level (SQLite can't express
// that as a CHECK). Imported WP comments use insertImportedComment.

import type { Db } from './db.ts';

export type CommentStatus = 'pending' | 'published' | 'queued' | 'rejected';
export type CommentSource = 'web' | 'wp-import';

export interface CommentRow {
  id: number;
  post_id: number;
  parent_id: number | null;
  wp_comment_id: number | null;
  author_name: string;
  author_email: string;
  body: string;
  status: CommentStatus;
  source: CommentSource;
  spam_score: number | null;
  spam_reason: string | null;
  ip: string | null;
  created_at: string;
  classified_at: string | null;
}

export interface NewWebComment {
  postId: number;
  parentId: number | null;
  authorName: string;
  authorEmail: string;
  body: string;
  ip: string | null;
}

/** Throw if parentId is set but does not reference a top-level
 * (parent_id IS NULL), published comment on the same post. Replies
 * may only target comments the reader can actually see; allowing a
 * pending/queued/rejected parent would silently orphan the reply if
 * the parent is later rejected. */
function assertTopLevelParent(db: Db, postId: number, parentId: number): void {
  const parent = db
    .prepare<{ parent_id: number | null; post_id: number; status: string }>(
      'SELECT parent_id, post_id, status FROM comments WHERE id = ?'
    )
    .get(parentId);
  if (!parent || parent.post_id !== postId || parent.status !== 'published') {
    throw new Error('parent comment not found or not published on this post');
  }
  if (parent.parent_id !== null) {
    throw new Error('parent must be a top-level comment');
  }
}

export function insertWebComment(db: Db, c: NewWebComment): number {
  if (c.parentId !== null) assertTopLevelParent(db, c.postId, c.parentId);
  const now = new Date().toISOString();
  const r = db
    .prepare(
      `INSERT INTO comments
         (post_id, parent_id, author_name, author_email, body,
          status, source, ip, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 'web', ?, ?)`
    )
    .run(c.postId, c.parentId, c.authorName, c.authorEmail, c.body, c.ip, now);
  return r.lastInsertRowid;
}

export interface ImportedComment {
  postId: number;
  parentId: number | null;
  wpCommentId: number;
  authorName: string;
  body: string;
  createdAt: string;
}

/** Insert an already-approved WP comment as published. Idempotent:
 * a duplicate wp_comment_id is ignored (returns null). */
export function insertImportedComment(db: Db, c: ImportedComment): number | null {
  const existing = db
    .prepare<{ id: number }>('SELECT id FROM comments WHERE wp_comment_id = ?')
    .get(c.wpCommentId);
  if (existing) return null;
  const r = db
    .prepare(
      `INSERT INTO comments
         (post_id, parent_id, wp_comment_id, author_name, author_email,
          body, status, source, created_at)
       VALUES (?, ?, ?, ?, /* sentinel: WP public API exposes no commenter email; never displayed */ 'imported@roll-along', ?, 'published',
               'wp-import', ?)`
    )
    .run(c.postId, c.parentId, c.wpCommentId, c.authorName, c.body, c.createdAt);
  return r.lastInsertRowid;
}

export function getCommentById(db: Db, id: number): CommentRow | undefined {
  return db.prepare<CommentRow>('SELECT * FROM comments WHERE id = ?').get(id);
}

export function setCommentStatus(db: Db, id: number, status: CommentStatus): void {
  const r = db.prepare('UPDATE comments SET status = ? WHERE id = ?').run(status, id);
  if (r.changes === 0) throw new Error(`comment ${id} not found`);
}

/** Persist a classifier verdict and resolve the row's status.
 * Only applies when the comment is still pending — if a moderator
 * approved or rejected the comment between classification starting
 * and finishing, the moderator's decision takes precedence. */
export function applyClassification(
  db: Db,
  id: number,
  v: { status: 'published' | 'queued'; score: number | null; reason: string | null }
): boolean {
  const r = db
    .prepare(
      `UPDATE comments
         SET status = ?, spam_score = ?, spam_reason = ?, classified_at = ?
       WHERE id = ? AND status = 'pending'`
    )
    .run(v.status, v.score, v.reason, new Date().toISOString(), id);
  if (r.changes === 0) {
    // Comment was already moderated — skip notification
    return false;
  }
  return true;
}

export interface ThreadComment {
  id: number;
  author_name: string;
  body: string;
  created_at: string;
  replies: ThreadComment[];
}

/** Total comments in a published thread (top-level + their one-level
 * replies). Replies never nest deeper (one-level threading invariant),
 * so a single pass suffices. */
export function countThread(thread: ThreadComment[]): number {
  return thread.reduce((n, c) => n + 1 + c.replies.length, 0);
}

/** Published comments for a post: top-level oldest-first, each with its
 * published replies oldest-first. */
export function listPublishedThread(db: Db, postId: number): ThreadComment[] {
  const rows = db
    .prepare<{
      id: number;
      parent_id: number | null;
      author_name: string;
      body: string;
      created_at: string;
    }>(
      `SELECT id, parent_id, author_name, body, created_at
         FROM comments
        WHERE post_id = ? AND status = 'published'
        ORDER BY created_at ASC, id ASC`
    )
    .all(postId);

  const top: ThreadComment[] = [];
  const byId = new Map<number, ThreadComment>();
  for (const r of rows) {
    if (r.parent_id === null) {
      const node: ThreadComment = {
        id: r.id,
        author_name: r.author_name,
        body: r.body,
        created_at: r.created_at,
        replies: []
      };
      byId.set(r.id, node);
      top.push(node);
    }
  }
  for (const r of rows) {
    if (r.parent_id !== null) {
      const parent = byId.get(r.parent_id);
      if (parent) {
        parent.replies.push({
          id: r.id,
          author_name: r.author_name,
          body: r.body,
          created_at: r.created_at,
          replies: []
        });
      }
    }
  }
  return top;
}

export interface ModerationRow {
  id: number;
  post_slug: string;
  author_name: string;
  body: string;
  status: CommentStatus;
  spam_score: number | null;
  spam_reason: string | null;
  created_at: string;
}

/** Moderation list: queued first (oldest-first so the backlog drains
 * FIFO), then the most recent published, capped. */
export function listForModeration(db: Db, limit = 100): ModerationRow[] {
  return db
    .prepare<ModerationRow>(
      `SELECT c.id, p.slug AS post_slug, c.author_name, c.body, c.status,
              c.spam_score, c.spam_reason, c.created_at
         FROM comments c
         JOIN posts p ON p.id = c.post_id
        WHERE c.status IN ('queued','published')
        ORDER BY (c.status = 'queued') DESC,
                 CASE WHEN c.status = 'queued' THEN c.created_at END ASC,
                 c.created_at DESC
        LIMIT ?`
    )
    .all(limit);
}

/** SELECT id FROM posts WHERE slug — comments need the numeric post id
 * which the reindex IndexedPost shape doesn't expose. */
export function getPostIdBySlug(db: Db, slug: string): number | null {
  return db.prepare<{ id: number }>('SELECT id FROM posts WHERE slug = ?').get(slug)?.id ?? null;
}

/** slug + title for a post id — the notify handler needs both to
 * build the email subject/permalink. Undefined when the post is gone. */
export function getPostMetaById(
  db: Db,
  postId: number
): { slug: string; title: string } | undefined {
  return db
    .prepare<{ slug: string; title: string }>('SELECT slug, title FROM posts WHERE id = ?')
    .get(postId);
}
