// `site-admin import-wp-comments <wp-base-url>` — one-shot, idempotent
// recovery of approved WordPress comments. The public WP comments
// endpoint returns only approved comments, so everything fetched is
// inserted as published / source='wp-import'. Idempotent via the
// comments.wp_comment_id UNIQUE column.

import path from 'node:path';

import { getPostIdBySlug, insertImportedComment } from '../lib/comments.ts';
import { open } from '../lib/db.ts';
import { listComments, listPosts, type WpFetcher } from '../lib/wp-rest.ts';

export interface ImportCommentsResult {
  inserted: number;
  skipped: number;
}

/** Strip HTML to plain text + decode the handful of entities WP emits.
 * We store comment bodies as text (escaped on render), so tags must go. */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .trim();
}

async function buildWpIdToSlug(baseUrl: string, fetcher?: WpFetcher): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  let page = 1;
  for (;;) {
    const r = await listPosts(
      baseUrl,
      { page, perPage: 100, status: 'publish' },
      ...(fetcher ? [fetcher] : [])
    );
    for (const p of r.posts) map.set(p.id, p.slug);
    if (page >= r.totalPages || r.posts.length === 0) break;
    page++;
  }
  return map;
}

export async function importWpComments(
  baseUrl: string,
  siteRoot: string,
  fetcher?: WpFetcher
): Promise<ImportCommentsResult> {
  const dbPath = path.join(siteRoot, 'data', 'site.db');
  const db = open(dbPath);
  let inserted = 0;
  let skipped = 0;
  try {
    const idToSlug = await buildWpIdToSlug(baseUrl, fetcher);
    const wpToLocal = new Map<number, number>();
    const wpTopLevel = new Set<number>(); // WP ids inserted as top-level local comments

    let page = 1;
    let totalPages = 1;
    do {
      const r = await listComments(baseUrl, { page, perPage: 100 }, ...(fetcher ? [fetcher] : []));
      totalPages = r.totalPages || 1;
      const sorted = [...r.comments].sort((a, b) => Number(a.parent) - Number(b.parent));
      for (const c of sorted) {
        const slug = idToSlug.get(c.post);
        if (!slug) {
          skipped++;
          continue;
        }
        const postId = getPostIdBySlug(db, slug);
        if (postId === null) {
          skipped++;
          continue;
        }
        // One-level threading (spec §7): only attach to a parent that is
        // itself a TOP-LEVEL local comment. A reply whose WP parent is
        // itself a reply (or was skipped) is flattened to top-level.
        let parentId: number | null = null;
        if (c.parent && wpTopLevel.has(c.parent)) {
          parentId = wpToLocal.get(c.parent) as number;
        }
        const localId = insertImportedComment(db, {
          postId,
          parentId,
          wpCommentId: c.id,
          authorName: c.author_name || 'Anonymous',
          authorUrl: c.author_url ? c.author_url : null,
          body: htmlToText(c.content.rendered),
          createdAt: c.date
        });
        if (localId === null) {
          skipped++;
        } else {
          wpToLocal.set(c.id, localId);
          if (parentId === null) wpTopLevel.add(c.id);
          inserted++;
        }
      }
      page++;
    } while (page <= totalPages);
  } finally {
    db.close();
  }
  return { inserted, skipped };
}

export default async function importWpCommentsCmd(argv: string[]): Promise<void> {
  const baseUrl = argv[0];
  if (!baseUrl) {
    throw new Error('usage: site-admin import-wp-comments <wp-base-url>');
  }
  /* c8 ignore start -- success path makes real HTTP calls; covered by importWpComments tests */
  const { paths } = await import('../lib/config.ts');
  const r = await importWpComments(baseUrl, paths().root);
  console.log(`imported ${r.inserted} comment(s), skipped ${r.skipped}`);
  /* c8 ignore stop */
}
