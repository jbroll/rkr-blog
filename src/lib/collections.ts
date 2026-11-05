// A collection is a tag with a published kind:page row of the same slug
// (spec.md §8a). Membership is computed per request, never stored.

import type { Db } from './db.ts';
import { RESERVED_SLUGS } from './reserved-slugs.ts';

// img, video, site-theme and pages already own a two-segment route, so a
// nested URL under them would never reach the page.
export const NON_COLLECTION_SLUGS: ReadonlySet<string> = new Set([
  ...RESERVED_SLUGS,
  'img',
  'video',
  'site-theme',
  'pages'
]);

export interface PageLink {
  path: string;
  title: string;
}

export interface CollectionNav {
  back: PageLink;
  prev: PageLink | null;
  next: PageLink | null;
}

const excluded = [...NON_COLLECTION_SLUGS].map((s) => `'${s}'`).join(', ');

/** SQL scalar: the slug of the collection the `a` row belongs to, or NULL. */
function collectionSlugSql(a: string): string {
  return `(SELECT c.slug FROM post_tags pt
    JOIN tags t ON t.id = pt.tag_id
    JOIN posts c ON c.slug = lower(t.name) AND c.kind = 'page' AND c.status = 'published'
    WHERE pt.post_id = ${a}.id AND c.slug <> ${a}.slug AND c.slug NOT IN (${excluded})
    ORDER BY pt.position LIMIT 1)`;
}

export function memberExclusionSql(postAlias: string): string {
  return `${collectionSlugSql(postAlias)} IS NULL`;
}

export function collectionOf(db: Db, slug: string): { slug: string; title: string } | null {
  return (
    db
      .prepare<{ slug: string; title: string }>(
        `SELECT c.slug, c.title FROM posts p JOIN posts c ON c.slug = ${collectionSlugSql('p')}
         WHERE p.slug = ?`
      )
      .get(slug) ?? null
  );
}

export function pagePath(db: Db, slug: string): string {
  const c = collectionOf(db, slug);
  return c ? `/${c.slug}/${encodeURIComponent(slug)}` : `/${encodeURIComponent(slug)}`;
}

export function collectionNav(db: Db, slug: string): CollectionNav | null {
  const c = collectionOf(db, slug);
  if (!c) return null;
  const members = db
    .prepare<{ slug: string; title: string }>(
      `SELECT p.slug, p.title FROM posts p
       WHERE (p.status = 'published' OR p.slug = ?) AND ${collectionSlugSql('p')} = ?
       ORDER BY p.sort_order IS NULL, p.sort_order, p.title, p.slug`
    )
    .all(slug, c.slug);
  const i = members.findIndex((m) => m.slug === slug);
  const link = (m: { slug: string; title: string } | undefined): PageLink | null =>
    m ? { path: `/${c.slug}/${encodeURIComponent(m.slug)}`, title: m.title } : null;
  return {
    back: { path: `/${c.slug}`, title: c.title },
    prev: link(members[i - 1]),
    next: link(members[i + 1])
  };
}
