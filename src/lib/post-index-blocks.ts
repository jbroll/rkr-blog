// The JSON-page half of the post index: one stored page to its `posts`
// row, FTS row and tags. `runReindex` (post-index.ts) runs it over every
// file; the editor's save runs it for the one page it wrote, so a save
// never re-reads the rest of the site.

import fs from 'node:fs';
import path from 'node:path';

import type { Root } from 'mdast';
import { remark } from 'remark';
import remarkDirective from 'remark-directive';
import { findBlockFile } from './block-pages.ts';
import { type BlockNode, type BlockTree, parseBlockTree } from './blocks.ts';
import type { Db } from './db.ts';
import { extractPlainText } from './post-text.ts';

/** Replace the full tag set for one post. */
export function syncPostTags(db: Db, postId: number, rawTags: string[]): void {
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

/** Plain-text bag for FTS: every text leaf's words (through the same
 * mdast extraction markdown posts use) plus button and marquee labels,
 * in document order. */
function extractBlockPlainText(tree: BlockTree): string {
  const parts: string[] = [];
  const walk = (node: BlockNode): void => {
    if (node.type === 'text' && node.markdown) {
      const words = extractPlainText(remark().use(remarkDirective).parse(node.markdown) as Root);
      if (words) parts.push(words);
    }
    if (node.type === 'button' && typeof node.slots?.label === 'string')
      parts.push(node.slots.label);
    if (node.type === 'marquee' && typeof node.slots?.text === 'string')
      parts.push(node.slots.text);
    if (node.type === 'grid') for (const k of node.children) walk(k);
  };
  for (const n of tree.body) walk(n);
  return parts.join('\n');
}

interface IndexablePage {
  tree: BlockTree;
  fields: Record<string, unknown> & { slug: string; title: string };
}

/** Parse one page file for the index. Throws with the reason. */
function readIndexablePage(fullPath: string): IndexablePage {
  const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as {
    body?: unknown;
    fields?: unknown;
  };
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !parsed.fields ||
    typeof parsed.fields !== 'object'
  ) {
    throw new Error('blocks page needs object fields');
  }
  const tree = parseBlockTree({ version: 1, body: parsed.body });
  const fields = parsed.fields as Record<string, unknown>;
  if (typeof fields.slug !== 'string' || !fields.slug || typeof fields.title !== 'string') {
    throw new Error('blocks page needs string fields.slug and fields.title');
  }
  return { tree, fields: fields as IndexablePage['fields'] };
}

/** Slugs of the page files in `blocksDir` the index would accept. */
export function indexableBlockSlugs(blocksDir: string): Set<string> {
  const slugs = new Set<string>();
  if (!fs.existsSync(blocksDir)) return slugs;
  for (const file of fs.readdirSync(blocksDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      slugs.add(readIndexablePage(path.join(blocksDir, file)).fields.slug);
    } catch {
      // Not indexable, so it cannot keep a post readable.
    }
  }
  return slugs;
}

/** Upsert the row, FTS row and tags for one page. The row is matched by
 * slug, so a twin shares its markdown sibling's row and comment thread.
 * While that sibling is on disk the row keeps its markdown path; after
 * archive it adopts the JSON path so the orphan check keeps it. */
function upsertBlockRow(
  db: Db,
  fullPath: string,
  page: IndexablePage,
  mdStillOnDisk: boolean
): 'inserted' | 'updated' {
  const { slug, title } = page.fields;
  const stat = fs.statSync(fullPath);
  const created = new Date(stat.birthtimeMs || stat.mtimeMs).toISOString();
  const updatedAt = new Date(stat.mtimeMs).toISOString();
  const status: 'draft' | 'published' = page.fields.status === 'draft' ? 'draft' : 'published';
  const date = page.fields.date;
  const publishedAt = status === 'published' ? (typeof date === 'string' ? date : updatedAt) : null;
  const tags = Array.isArray(page.fields.tags) ? (page.fields.tags as string[]) : [];
  const relPath = path.posix.join('content', 'blocks', path.basename(fullPath));
  const kind = page.fields.kind === 'page' ? 'page' : 'post';

  const existing = db.prepare<{ id: number }>('SELECT id FROM posts WHERE slug = ?').get(slug);
  if (existing) {
    if (mdStillOnDisk) {
      db.prepare(
        `UPDATE posts SET title = ?, status = ?, updated_at = ?, published_at = ?, kind = ?
         WHERE id = ?`
      ).run(title, status, updatedAt, publishedAt, kind, existing.id);
    } else {
      db.prepare(
        `UPDATE posts SET title = ?, status = ?, updated_at = ?, published_at = ?, path = ?, kind = ?
         WHERE id = ?`
      ).run(title, status, updatedAt, publishedAt, relPath, kind, existing.id);
    }
  } else {
    db.prepare(
      `INSERT INTO posts (slug, title, status, created_at, updated_at, published_at, path, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(slug, title, status, created, updatedAt, publishedAt, relPath, kind);
  }

  db.prepare('DELETE FROM posts_fts WHERE slug = ?').run(slug);
  db.prepare('INSERT INTO posts_fts (slug, title, tags, body) VALUES (?, ?, ?, ?)').run(
    slug,
    title,
    tags.join(' '),
    extractBlockPlainText(page.tree)
  );
  const postId =
    existing?.id ??
    (db.prepare<{ id: number }>('SELECT id FROM posts WHERE slug = ?').get(slug)?.id as number);
  syncPostTags(db, postId, tags);
  return existing ? 'updated' : 'inserted';
}

/** The JSON pass of a full reindex, inside the caller's transaction.
 * The first file (sorted) claiming a slug wins, as in block-pages.ts. */
export function indexBlockPages(
  db: Db,
  blocksDir: string,
  files: Iterable<string>,
  mdSlugs: ReadonlySet<string>
): { inserted: number; updated: number; insertedSlugs: string[] } {
  const seen = new Map<string, string>();
  const insertedSlugs: string[] = [];
  let updated = 0;
  for (const filename of files) {
    const fullPath = path.join(blocksDir, filename);
    let page: IndexablePage;
    try {
      page = readIndexablePage(fullPath);
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: surface unparseable twins to reindex output
      console.error(
        `reindex: JSON parse failed for ${filename} — retaining any existing DB row and comments: ${(err as Error).message}`
      );
      continue;
    }
    const { slug } = page.fields;
    if (slug.startsWith('_')) continue;
    // Twins share their slug with the markdown sibling by design; only a
    // second JSON file claiming the same slug is a duplicate.
    if (seen.has(slug)) {
      // biome-ignore lint/suspicious/noConsole: surface duplicate slugs to reindex output
      console.error(`reindex: duplicate slug "${slug}" in blocks/${filename} — skipping`);
      continue;
    }
    seen.set(slug, filename);
    if (upsertBlockRow(db, fullPath, page, mdSlugs.has(slug)) === 'inserted') {
      insertedSlugs.push(slug);
    } else updated++;
  }
  return { inserted: insertedSlugs.length, updated, insertedSlugs };
}

/** Index the one page `slug` resolves to, after a save. A markdown
 * sibling counts as on disk when the existing row still points at it. */
export function reindexBlockPage(db: Db, siteRoot: string, slug: string): void {
  const file = findBlockFile(siteRoot, slug);
  if (!file || slug.startsWith('_')) return;
  let page: IndexablePage;
  try {
    page = readIndexablePage(file);
  } catch {
    return;
  }
  const row = db.prepare<{ path: string }>('SELECT path FROM posts WHERE slug = ?').get(slug);
  const mdStillOnDisk =
    !!row &&
    path.posix.dirname(row.path) !== 'content/blocks' &&
    fs.existsSync(path.join(siteRoot, row.path));
  db.transaction(() => {
    upsertBlockRow(db, file, page, mdStillOnDisk);
    db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM post_tags)').run();
  })();
}

/** Remove a deleted page's row, FTS row and now-unused tags. Comments and
 * post_tags go with the row (ON DELETE CASCADE), as a deleted markdown
 * post's did. */
export function dropIndexedPost(db: Db, slug: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM posts WHERE slug = ?').run(slug);
    db.prepare('DELETE FROM posts_fts WHERE slug = ?').run(slug);
    db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM post_tags)').run();
  })();
}
