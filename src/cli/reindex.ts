// `site-admin reindex` — rebuild the posts table from the markdown files
// under content/posts/. The filesystem is the source of truth; the table
// is just an index for fast `GET /` and `GET /:slug` queries.

import fs from 'node:fs';
import path from 'node:path';

import { paths } from '../lib/config.ts';
import { type PostFrontmatter, parsePost } from '../lib/content.ts';
import { type Db, open } from '../lib/db.ts';
import { migrate } from '../lib/migrate.ts';

export interface IndexedPost {
  slug: string;
  title: string;
  status: 'draft' | 'published';
  created_at: string;
  updated_at: string;
  published_at: string | null;
  path: string;
}

export interface TagCount {
  name: string;
  count: number;
}

export default async function reindexCmd(_argv: string[]): Promise<void> {
  const r = runReindex(paths().root);
  console.log(
    `reindex: ${r.inserted + r.updated} indexed (${r.inserted} new, ${r.updated} updated, ${r.removed} removed)`
  );
}

/** Exposed for tests. Returns counts. */
export function runReindex(siteRoot: string): {
  inserted: number;
  updated: number;
  removed: number;
} {
  const dbPath = path.join(siteRoot, 'data', 'site.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = open(dbPath);
  try {
    migrate(db);
    return doReindex(siteRoot, db);
  } finally {
    db.close();
  }
}

function doReindex(
  siteRoot: string,
  db: Db
): { inserted: number; updated: number; removed: number } {
  const postsDir = path.join(siteRoot, 'content', 'posts');
  if (!fs.existsSync(postsDir)) fs.mkdirSync(postsDir, { recursive: true });

  const onDisk = listMarkdown(postsDir);
  const seenSlugs = new Set<string>();

  let inserted = 0;
  let updated = 0;

  const upsert = db.transaction(() => {
    for (const filename of onDisk) {
      const fullPath = path.join(postsDir, filename);
      const raw = fs.readFileSync(fullPath, 'utf8');
      let frontmatter: PostFrontmatter;
      try {
        frontmatter = parsePost(raw).frontmatter;
      } catch (err) {
        console.error(`reindex: skipping ${filename}: ${(err as Error).message}`);
        continue;
      }

      const slug = frontmatter.slug;
      // System posts (_-prefixed) are saved on disk but excluded from the
      // posts index so they never appear in the public or admin listing.
      if (slug.startsWith('_')) continue;
      seenSlugs.add(slug);

      const stat = fs.statSync(fullPath);
      const created = new Date(stat.birthtimeMs || stat.mtimeMs).toISOString();
      const updatedAt = new Date(stat.mtimeMs).toISOString();
      const status: 'draft' | 'published' = frontmatter.status === 'draft' ? 'draft' : 'published';
      const publishedAt =
        status === 'published'
          ? typeof frontmatter.date === 'string'
            ? frontmatter.date
            : updatedAt
          : null;
      const relPath = path.posix.join('content', 'posts', filename);

      const existing = db.prepare<{ id: number }>('SELECT id FROM posts WHERE slug = ?').get(slug);

      if (existing) {
        db.prepare(
          `UPDATE posts SET title = ?, status = ?, updated_at = ?, published_at = ?, path = ?
           WHERE id = ?`
        ).run(frontmatter.title, status, updatedAt, publishedAt, relPath, existing.id);
        updated++;
      } else {
        db.prepare(
          `INSERT INTO posts (slug, title, status, created_at, updated_at, published_at, path)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(slug, frontmatter.title, status, created, updatedAt, publishedAt, relPath);
        inserted++;
      }

      // Sync tags for this post.
      const postId =
        existing?.id ??
        (db.prepare<{ id: number }>('SELECT id FROM posts WHERE slug = ?').get(slug)?.id as number);
      syncPostTags(
        db,
        postId,
        Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]) : []
      );
    }
  });
  upsert();

  // Remove rows whose source file is gone.
  // ON DELETE CASCADE in post_tags keeps that table clean automatically.
  // _-prefixed slugs are never added to the index, so skip them in the
  // orphan filter too — they can never be orphans.
  const removed = db.transaction((): number => {
    const all = db.prepare<{ id: number; slug: string }>('SELECT id, slug FROM posts').all();
    const orphans = all.filter((row) => !row.slug.startsWith('_') && !seenSlugs.has(row.slug));
    for (const o of orphans) {
      db.prepare('DELETE FROM posts WHERE id = ?').run(o.id);
    }
    return orphans.length;
  })();

  // Prune tags that no longer appear in any post_tags row.
  db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM post_tags)').run();

  return { inserted, updated, removed };
}

/** Replace the full tag set for one post. Called inside the upsert transaction. */
function syncPostTags(db: Db, postId: number, rawTags: string[]): void {
  db.prepare('DELETE FROM post_tags WHERE post_id = ?').run(postId);
  for (const raw of rawTags) {
    const name = String(raw).trim();
    if (!name) continue;
    db.prepare('INSERT OR IGNORE INTO tags(name) VALUES (?)').run(name);
    const tag = db
      .prepare<{ id: number }>('SELECT id FROM tags WHERE name = ? COLLATE NOCASE')
      .get(name);
    if (tag) {
      db.prepare('INSERT OR IGNORE INTO post_tags(post_id, tag_id) VALUES (?, ?)').run(
        postId,
        tag.id
      );
    }
  }
}

function listMarkdown(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
}

export function readIndexedPosts(
  db: Db,
  opts: {
    limit?: number;
    offset?: number;
    status?: 'draft' | 'published' | null;
    /** Optional tag filter (at most one element; OR/replace logic at the UI layer). */
    tags?: string[];
    /** 'desc' (default) = newest first; 'asc' = oldest first. */
    sort?: 'asc' | 'desc';
  } = {}
): IndexedPost[] {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const tags = opts.tags && opts.tags.length > 0 ? opts.tags : null;
  const dir = opts.sort === 'asc' ? 'ASC' : 'DESC';

  const tagFilter = tags
    ? `AND p.id IN (
         SELECT pt.post_id FROM post_tags pt
         JOIN tags tg ON tg.id = pt.tag_id
         WHERE tg.name IN (${tags.map(() => '?').join(', ')}) COLLATE NOCASE
         GROUP BY pt.post_id
         HAVING COUNT(DISTINCT pt.tag_id) = ${tags.length}
       )`
    : '';
  const tagParams: string[] = tags ?? [];

  // status === null → no filter (admin view: drafts + published).
  // status === undefined → default to 'published' (anonymous view).
  // status === 'draft' | 'published' → filter to that status.
  if (opts.status === null) {
    return db
      .prepare<IndexedPost>(
        `SELECT p.slug, p.title, p.status, p.created_at, p.updated_at, p.published_at, p.path
           FROM posts p
          WHERE 1=1 ${tagFilter}
          ORDER BY COALESCE(p.published_at, p.created_at) ${dir}, p.slug ASC
          LIMIT ? OFFSET ?`
      )
      .all(...tagParams, limit, offset);
  }
  const status = opts.status ?? 'published';
  return db
    .prepare<IndexedPost>(
      `SELECT p.slug, p.title, p.status, p.created_at, p.updated_at, p.published_at, p.path
         FROM posts p
        WHERE p.status = ? ${tagFilter}
        ORDER BY p.published_at ${dir}, p.slug ASC
        LIMIT ? OFFSET ?`
    )
    .all(status, ...tagParams, limit, offset);
}

/** Tag counts for the sidebar.
 * status === null → count all posts; status === 'published' → published only. */
export function readTagCounts(db: Db, opts: { status: 'published' | null }): TagCount[] {
  if (opts.status === null) {
    return db
      .prepare<TagCount>(
        `SELECT t.name, COUNT(*) AS count
           FROM tags t
           JOIN post_tags pt ON pt.tag_id = t.id
          GROUP BY t.id
          ORDER BY t.name DESC`
      )
      .all();
  }
  return db
    .prepare<TagCount>(
      `SELECT t.name, COUNT(*) AS count
         FROM tags t
         JOIN post_tags pt ON pt.tag_id = t.id
         JOIN posts p ON p.id = pt.post_id AND p.status = ?
        GROUP BY t.id
        ORDER BY t.name DESC`
    )
    .all(opts.status);
}

/** All indexed posts (drafts + published), newest-updated first.
 * Backs the admin posts page (`GET /admin/posts`) where the author
 * needs visibility into drafts that the public index hides. */
export function readAllIndexedPosts(db: Db): IndexedPost[] {
  return db
    .prepare<IndexedPost>(
      `SELECT slug, title, status, created_at, updated_at, published_at, path
         FROM posts
        ORDER BY updated_at DESC, slug ASC`
    )
    .all();
}

export function readIndexedPostBySlug(db: Db, slug: string): IndexedPost | undefined {
  return db
    .prepare<IndexedPost>(
      `SELECT slug, title, status, created_at, updated_at, published_at, path
         FROM posts
        WHERE slug = ?`
    )
    .get(slug);
}
