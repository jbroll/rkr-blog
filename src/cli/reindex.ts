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
    }
  });
  upsert();

  // Remove rows whose source file is gone.
  const removed = db.transaction((): number => {
    const all = db.prepare<{ id: number; slug: string }>('SELECT id, slug FROM posts').all();
    const orphans = all.filter((row) => !seenSlugs.has(row.slug));
    for (const o of orphans) {
      db.prepare('DELETE FROM posts WHERE id = ?').run(o.id);
    }
    return orphans.length;
  })();

  return { inserted, updated, removed };
}

function listMarkdown(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
}

export function readIndexedPosts(
  db: Db,
  opts: { limit?: number; offset?: number; status?: 'draft' | 'published' } = {}
): IndexedPost[] {
  const status = opts.status ?? 'published';
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  return db
    .prepare<IndexedPost>(
      `SELECT slug, title, status, created_at, updated_at, published_at, path
         FROM posts
        WHERE status = ?
        ORDER BY published_at DESC, slug ASC
        LIMIT ? OFFSET ?`
    )
    .all(status, limit, offset);
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
