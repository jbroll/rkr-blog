// Pure post-index read/write/transform layer. The markdown files under
// content/posts/ are the source of truth; the `posts` table is just an
// index for fast `GET /` and `GET /:slug` queries. `runReindex` rebuilds
// that index; the `read*` helpers query it for the delivery layer.

import fs from 'node:fs';
import path from 'node:path';

import type { Root } from 'mdast';
import { type BlockNode, type BlockTree, parseBlockTree } from './blocks.ts';
import { type PostFrontmatter, parsePost } from './content.ts';
import { type Db, open } from './db.ts';
import { migrate } from './migrate.ts';
import { extractPlainText } from './post-text.ts';

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
  const blocksDir = path.join(siteRoot, 'content', 'blocks');
  if (!fs.existsSync(blocksDir)) fs.mkdirSync(blocksDir, { recursive: true });

  // Collect ALL filenames on disk first, independent of parseability.
  // This is the ground truth for "file exists" — used in the orphan step
  // to ensure a parse failure never triggers a cascade delete of comments.
  const onDiskFiles = new Set(listMarkdown(postsDir));
  const onDiskBlocks = new Set(listJson(blocksDir));
  const slugToFile = new Map<string, string>(); // duplicate-slug detection
  const slugToBlockFile = new Map<string, string>();

  let inserted = 0;
  let updated = 0;

  // Snapshot of existing posts before upsert — used to match renames.
  const beforeRows = db
    .prepare<{ id: number; slug: string; path: string }>('SELECT id, slug, path FROM posts')
    .all();
  const beforeSlugToRow = new Map(beforeRows.map((r) => [r.slug, r]));
  const beforePathToRow = new Map(beforeRows.map((r) => [r.path, r]));

  const insertedSlugs = new Set<string>();

  const upsert = db.transaction(() => {
    for (const filename of onDiskFiles) {
      const fullPath = path.join(postsDir, filename);
      const raw = fs.readFileSync(fullPath, 'utf8');
      let frontmatter: PostFrontmatter;
      let ast: Root;
      try {
        const parsed = parsePost(raw);
        frontmatter = parsed.frontmatter;
        ast = parsed.ast;
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole: surface unparseable posts to reindex output
        console.error(
          `reindex: parse failed for ${filename} — retaining any existing DB row and comments: ${(err as Error).message}`
        );
        continue;
      }

      const slug = frontmatter.slug;
      // System posts (_-prefixed) are saved on disk but excluded from the
      // posts index so they never appear in the public or admin listing.
      if (slug.startsWith('_')) continue;
      if (slugToFile.has(slug)) {
        // biome-ignore lint/suspicious/noConsole: surface duplicate slugs to reindex output
        console.error(
          `reindex: duplicate slug "${slug}" in ${filename} (already indexed from ${slugToFile.get(slug)}) — skipping`
        );
        continue;
      }
      slugToFile.set(slug, filename);

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

      // Prefer match by path (handles slug-change without rename), then by slug (handles rename without slug change).
      const existingByPath = db
        .prepare<{ id: number; slug: string }>('SELECT id, slug FROM posts WHERE path = ?')
        .get(relPath);
      const existingBySlug = !existingByPath
        ? db.prepare<{ id: number }>('SELECT id FROM posts WHERE slug = ?').get(slug)
        : null;
      const existing = existingByPath ?? existingBySlug;

      // Keep FTS in sync when slug changes via path match: remove old slug's FTS row.
      const oldSlug = existingByPath && existingByPath.slug !== slug ? existingByPath.slug : null;

      if (existing) {
        db.prepare(
          `UPDATE posts SET slug = ?, title = ?, status = ?, updated_at = ?, published_at = ?, path = ?
           WHERE id = ?`
        ).run(slug, frontmatter.title, status, updatedAt, publishedAt, relPath, existing.id);
        if (oldSlug) db.prepare('DELETE FROM posts_fts WHERE slug = ?').run(oldSlug);
        updated++;
      } else {
        db.prepare(
          `INSERT INTO posts (slug, title, status, created_at, updated_at, published_at, path)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(slug, frontmatter.title, status, created, updatedAt, publishedAt, relPath);
        insertedSlugs.add(slug);
        inserted++;
      }

      // Refresh the FTS row for this post (title + tags + plain-text
      // body). Delete-then-insert keeps it in lockstep with `posts`.
      const tagText = Array.isArray(frontmatter.tags)
        ? (frontmatter.tags as string[]).join(' ')
        : '';
      db.prepare('DELETE FROM posts_fts WHERE slug = ?').run(slug);
      db.prepare('INSERT INTO posts_fts (slug, title, tags, body) VALUES (?, ?, ?, ?)').run(
        slug,
        frontmatter.title,
        tagText,
        extractPlainText(ast)
      );

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

    // JSON twins: content/blocks/*.json matched to posts by fields.slug.
    // A twin overrides its markdown sibling's indexed fields (title,
    // status, tags, FTS body) while the row keeps the markdown path and
    // id, so comment threads survive the cutover. JSON-only pages get
    // their own rows pointing at content/blocks/.
    for (const filename of onDiskBlocks) {
      const fullPath = path.join(blocksDir, filename);
      let raw: string;
      try {
        raw = fs.readFileSync(fullPath, 'utf8');
      } catch {
        continue;
      }
      let tree: BlockTree;
      let fields: Record<string, unknown>;
      try {
        const parsed = JSON.parse(raw) as { version?: unknown; body?: unknown; fields?: unknown };
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          !parsed.fields ||
          typeof parsed.fields !== 'object'
        ) {
          throw new Error('blocks page needs object fields');
        }
        tree = parseBlockTree({ version: 1, body: parsed.body });
        fields = parsed.fields as Record<string, unknown>;
        if (typeof fields.slug !== 'string' || !fields.slug || typeof fields.title !== 'string') {
          throw new Error('blocks page needs string fields.slug and fields.title');
        }
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole: surface unparseable twins to reindex output
        console.error(
          `reindex: JSON parse failed for ${filename} — retaining any existing DB row and comments: ${(err as Error).message}`
        );
        continue;
      }
      const slug = fields.slug as string;
      if (slug.startsWith('_')) continue;
      // Twins share their slug with the markdown sibling by design;
      // only a second JSON file claiming the same slug is a duplicate.
      if (slugToBlockFile.has(slug)) {
        // biome-ignore lint/suspicious/noConsole: surface duplicate slugs to reindex output
        console.error(`reindex: duplicate slug "${slug}" in blocks/${filename} — skipping`);
        continue;
      }
      slugToBlockFile.set(slug, filename);

      const stat = fs.statSync(fullPath);
      const created = new Date(stat.birthtimeMs || stat.mtimeMs).toISOString();
      const updatedAt = new Date(stat.mtimeMs).toISOString();
      const status: 'draft' | 'published' = fields.status === 'draft' ? 'draft' : 'published';
      const publishedAt =
        status === 'published' ? (typeof fields.date === 'string' ? fields.date : updatedAt) : null;
      const tags = Array.isArray(fields.tags) ? (fields.tags as string[]) : [];

      // Match by slug only: a twin shares its row (and comment thread)
      // with the markdown sibling, never by path.
      const existing = db.prepare<{ id: number }>('SELECT id FROM posts WHERE slug = ?').get(slug);
      if (existing) {
        db.prepare(
          `UPDATE posts SET slug = ?, title = ?, status = ?, updated_at = ?, published_at = ?
           WHERE id = ?`
        ).run(slug, fields.title as string, status, updatedAt, publishedAt, existing.id);
        updated++;
      } else {
        const relPath = path.posix.join('content', 'blocks', filename);
        db.prepare(
          `INSERT INTO posts (slug, title, status, created_at, updated_at, published_at, path)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(slug, fields.title as string, status, created, updatedAt, publishedAt, relPath);
        insertedSlugs.add(slug);
        inserted++;
      }

      db.prepare('DELETE FROM posts_fts WHERE slug = ?').run(slug);
      db.prepare('INSERT INTO posts_fts (slug, title, tags, body) VALUES (?, ?, ?, ?)').run(
        slug,
        fields.title as string,
        tags.join(' '),
        extractBlockPlainText(tree)
      );

      const postId =
        existing?.id ??
        (db.prepare<{ id: number }>('SELECT id FROM posts WHERE slug = ?').get(slug)?.id as number);
      syncPostTags(db, postId, tags);
    }
  });
  upsert();

  // Handle simultaneous file-rename + slug-change: the upsert above inserted
  // a new row for the new file while the old row is now an orphan. Instead
  // of deleting the orphan (and CASCADE-deleting its comments), migrate the
  // orphan's id to the new slug/path and remove the duplicate insert.
  // This is best-effort: only when one orphan and one insert are unpaired
  // by both path and slug, we treat them as the same logical post.
  if (insertedSlugs.size > 0) {
    const allAfterUpsert = db
      .prepare<{ id: number; slug: string; path: string }>('SELECT id, slug, path FROM posts')
      .all();
    const orphansBeforeDelete = allAfterUpsert.filter((row) =>
      isOrphanRow(row, onDiskFiles, onDiskBlocks)
    );
    // Build map of newly inserted rows (those whose slug was not in before snapshot).
    const newlyInserted = allAfterUpsert.filter((r) => insertedSlugs.has(r.slug));
    for (const orphan of orphansBeforeDelete) {
      // Skip if orphan already matched via path/slug above (should not be orphan).
      // Find a newly inserted candidate whose slug/path are both absent from before snapshot.
      const candidate = newlyInserted.find(
        (n) => !beforeSlugToRow.has(n.slug) && !beforePathToRow.has(n.path) && n.id !== orphan.id
      );
      if (!candidate) continue;
      // Only migrate if orphan has comments to preserve — otherwise orphan
      // deletion is harmless and the insert can stay.
      const commentCount = db
        .prepare<{ c: number }>('SELECT COUNT(*) as c FROM comments WHERE post_id = ?')
        .get(orphan.id)?.c;
      if (!commentCount) continue;
      // Migrate: move candidate's content onto orphan's id, then remove candidate.
      const candidateRow = db
        .prepare<{
          slug: string;
          title: string;
          status: string;
          published_at: string | null;
          path: string;
        }>('SELECT slug, title, status, published_at, path FROM posts WHERE id = ?')
        .get(candidate.id);
      if (!candidateRow) continue;
      // Free the new slug before moving orphan onto it (unique constraint).
      db.prepare('DELETE FROM posts_fts WHERE slug = ?').run(orphan.slug);
      db.prepare('UPDATE post_tags SET post_id = ? WHERE post_id = ?').run(orphan.id, candidate.id);
      db.prepare('DELETE FROM posts WHERE id = ?').run(candidate.id);
      db.prepare(
        `UPDATE posts SET slug = ?, title = ?, status = ?, published_at = ?, path = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        candidateRow.slug,
        candidateRow.title,
        candidateRow.status,
        candidateRow.published_at,
        candidateRow.path,
        new Date().toISOString(),
        orphan.id
      );
      // Remove candidate from tracking so it isn't considered again.
      insertedSlugs.delete(candidateRow.slug);
      // Adjust counts: the insert was actually an update via migration.
      inserted--;
      updated++;
      // Only handle one orphan per run to keep it simple; multiple simultaneous renames are rare.
      break;
    }
  }

  // Remove rows whose source file is gone.
  // ON DELETE CASCADE in post_tags keeps that table clean automatically.
  // _-prefixed slugs are never added to the index, so skip them in the
  // orphan filter too — they can never be orphans.
  // IMPORTANT: only delete a post when its .md file is genuinely absent
  // from disk. A parse failure alone must never trigger a cascade delete
  // of comments; the file must be physically missing.
  const removed = db.transaction((): number => {
    const all = db
      .prepare<{ id: number; slug: string; path: string }>('SELECT id, slug, path FROM posts')
      .all();
    const orphans = all.filter((row) => isOrphanRow(row, onDiskFiles, onDiskBlocks));
    for (const o of orphans) {
      db.prepare('DELETE FROM posts WHERE id = ?').run(o.id);
      db.prepare('DELETE FROM posts_fts WHERE slug = ?').run(o.slug);
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
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
}

/** JSON page files backing the blocks editor. Missing dir (pre-blocks
 * site roots) indexes as empty rather than throwing. */
function listJson(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

/** Plain-text bag for FTS: every text leaf's markdown plus button and
 * marquee labels, in document order. */
function extractBlockPlainText(tree: BlockTree): string {
  const parts: string[] = [];
  const walk = (node: BlockNode): void => {
    if (node.type === 'text' && node.markdown) parts.push(node.markdown);
    if (node.type === 'button' && typeof node.slots?.label === 'string')
      parts.push(node.slots.label);
    if (node.type === 'marquee' && typeof node.slots?.text === 'string')
      parts.push(node.slots.text);
    if (node.type === 'macro') return;
    const n = node as { children?: BlockNode[]; blocks?: BlockNode[] };
    for (const k of n.children ?? n.blocks ?? []) walk(k);
  };
  for (const n of tree.body) walk(n);
  return parts.join('\n');
}

/** Orphan test that knows both content dirs. Rows pointing into
 * content/blocks/ are checked against the JSON listing; everything
 * else keeps the historical basename-against-markdown rule. */
function isOrphanRow(
  row: { slug: string; path: string },
  mdFiles: Set<string>,
  blocksFiles: Set<string>
): boolean {
  if (row.slug.startsWith('_')) return false;
  if (path.posix.dirname(row.path) === 'content/blocks') {
    return !blocksFiles.has(path.basename(row.path));
  }
  return !mdFiles.has(path.basename(row.path));
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
