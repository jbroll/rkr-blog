// Rows for a macro list slot filled from a tag (spec.md §8a List slots).

import type { Slots } from './blocks.ts';
import { pagePath } from './collections.ts';
import type { Db } from './db.ts';
import type { TagSource } from './tag-source.ts';

interface TaggedPost {
  slug: string;
  title: string;
  excerpt: string | null;
  image: string | null;
  published_at: string | null;
}

export function listTaggedRows(db: Db, src: TagSource, selfSlug?: string): Slots[] {
  const orderBy =
    src.sort === 'date'
      ? 'p.published_at DESC, p.title, p.slug'
      : 'p.sort_order IS NULL, p.sort_order, p.title, p.slug';
  const posts = db
    .prepare<TaggedPost>(
      `SELECT p.slug, p.title, p.excerpt, p.image, p.published_at FROM posts p
       WHERE p.status = 'published' AND p.slug <> ?
         AND EXISTS (SELECT 1 FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
                     WHERE pt.post_id = p.id AND t.name = ? COLLATE NOCASE)
       ORDER BY ${orderBy}${src.limit ? ' LIMIT ?' : ''}`
    )
    .all(selfSlug ?? '', src.tag, ...(src.limit ? [src.limit] : []));
  return posts.map((p) => ({
    title: p.title,
    text: p.excerpt ?? '',
    href: pagePath(db, p.slug),
    image: p.image ?? '',
    date: p.published_at ?? ''
  }));
}
