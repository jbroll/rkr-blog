// WP content out of a database dump converted by lib/wp-dump.ts, plus
// the site's wp-content/uploads tree. Produces the same WpPost /
// WpComment shapes lib/wp-rest.ts returns, so the import pipeline runs
// unchanged with no network access.
//
// post_content is raw Gutenberg HTML rather than REST's rendered
// output. It carries real <p>/<figure>/<img> markup but no srcset, so
// each <img src> is annotated with `#wp-image-<id>` from its
// `wp-image-<id>` class; lib/wp-sqlite-images.ts uses that to reach the
// full-size original instead of the resized variant in the markup.

import type { Readable } from 'node:stream';

import { type Db, open, type SqlParam } from './db.ts';
import { slugify } from './slugify.ts';
import type {
  CommentListResult,
  ListResult,
  WpComment,
  WpPost,
  WpSiteInfo
} from './wp-import-types.ts';
import type { ListCommentsOpts, ListPostsOpts, WpSource } from './wp-source.ts';
import { sqliteImageFetcher } from './wp-sqlite-images.ts';

export interface SqliteSourceOpts {
  /** Path to the database written by `site-admin wp-dump`. */
  dbPath: string;
  /** Path to the backup's wp-content/uploads directory. */
  uploadsRoot: string;
}

interface PostRow {
  ID: number;
  post_date: string;
  post_modified: string;
  post_content: string;
  post_title: string;
  post_excerpt: string;
  post_status: string;
  post_name: string;
}

interface CommentRow {
  comment_ID: number;
  comment_post_ID: number;
  comment_parent: number;
  comment_author: string;
  comment_author_url: string;
  comment_date: string;
  comment_content: string;
}

/** WP stores `YYYY-MM-DD HH:MM:SS`; the REST API and the importer both
 * expect ISO-8601 with a `T`. */
function isoDate(wpDate: string): string {
  return wpDate.replace(' ', 'T');
}

function slugFor(row: PostRow): string {
  if (row.post_name) return row.post_name;
  const derived = slugify(row.post_title);
  return derived.startsWith('untitled-') ? `post-${row.ID}` : derived;
}

/** Tag each <img> src with its attachment id so the image fetcher can
 * resolve the full-size original. Idempotent: an src that already
 * carries a fragment is left alone. The leading `\s` keeps `data-src="`
 * and friends from being mistaken for the real attribute. */
function annotateImages(html: string): string {
  return html.replace(/<img\b[^>]*>/g, (tag) => {
    const id = /class="[^"]*\bwp-image-(\d+)\b[^"]*"/.exec(tag)?.[1];
    if (!id) return tag;
    return tag.replace(/(\s)src="([^"#]+)"/, `$1src="$2#wp-image-${id}"`);
  });
}

const PERMALINK_TAGS = new Set([
  '%year%',
  '%monthnum%',
  '%day%',
  '%hour%',
  '%minute%',
  '%second%',
  '%post_id%',
  '%postname%'
]);

/** WP's `permalink_structure` applied to one post, or null when the
 * structure is empty, uses a tag we cannot resolve from wp_posts alone
 * (`%category%`, `%author%`, …), or needs a date this row does not have.
 * Callers fall back to `<base>/<slug>` rather than emit a wrong URL. */
function permalinkPath(structure: string, row: PostRow, slug: string): string | null {
  const tags = structure.match(/%[^%\s/]+%/g);
  if (!tags || tags.length === 0) return null;
  if (tags.some((tag) => !PERMALINK_TAGS.has(tag))) return null;

  const parts = /^(?!0000)(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(row.post_date);
  const values: Record<string, string | undefined> = {
    '%year%': parts?.[1],
    '%monthnum%': parts?.[2],
    '%day%': parts?.[3],
    '%hour%': parts?.[4],
    '%minute%': parts?.[5],
    '%second%': parts?.[6],
    '%post_id%': String(row.ID),
    '%postname%': slug
  };
  if (tags.some((tag) => values[tag] === undefined)) return null;
  return structure.replace(/%[^%\s/]+%/g, (tag) => values[tag] ?? tag);
}

function statusFilter(status: string | undefined): { sql: string; params: SqlParam[] } {
  const wanted = status ?? 'publish';
  if (wanted === 'any') return { sql: "post_status IN ('publish','draft')", params: [] };
  return { sql: 'post_status = ?', params: [wanted] };
}

export function sqliteSource(opts: SqliteSourceOpts): WpSource {
  const db: Db = open(opts.dbPath);
  const fetchImage = sqliteImageFetcher(db, opts.uploadsRoot);

  const option = (name: string): string =>
    db
      .prepare<{ option_value: string }>(
        'SELECT option_value FROM wp_options WHERE option_name = ?'
      )
      .get(name)?.option_value ?? '';

  const siteUrl = (): string => option('siteurl').replace(/\/$/, '');

  /** WP builds permalinks from `home`, which differs from `siteurl` on a
   * subdirectory install. */
  const homeUrl = (): string => (option('home') || option('siteurl')).replace(/\/$/, '');

  const permalink = (row: PostRow, slug: string): string => {
    const base = homeUrl();
    const rel = permalinkPath(option('permalink_structure'), row, slug);
    return rel === null ? `${base}/${slug}` : `${base}${rel}`;
  };

  const termIds = (postId: number, taxonomy: string): number[] =>
    db
      .prepare<{ term_id: number }>(
        `SELECT tt.term_id AS term_id
           FROM wp_term_relationships tr
           JOIN wp_term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
          WHERE tr.object_id = ? AND tt.taxonomy = ?
          ORDER BY tt.term_id`
      )
      .all(postId, taxonomy)
      .map((r) => r.term_id);

  const attachedFile = (mediaId: number): string | null =>
    db
      .prepare<{ meta_value: string }>(
        "SELECT meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key = '_wp_attached_file'"
      )
      .get(mediaId)?.meta_value ?? null;

  const toWpPost = (row: PostRow): WpPost => {
    const slug = slugFor(row);
    const thumb = db
      .prepare<{ meta_value: string }>(
        "SELECT meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key = '_thumbnail_id'"
      )
      .get(row.ID)?.meta_value;
    return {
      id: row.ID,
      date: isoDate(row.post_date),
      modified: isoDate(row.post_modified),
      slug,
      status: row.post_status,
      title: { rendered: row.post_title },
      content: { rendered: annotateImages(row.post_content) },
      excerpt: { rendered: row.post_excerpt },
      link: permalink(row, slug),
      tags: termIds(row.ID, 'post_tag'),
      categories: termIds(row.ID, 'category'),
      featured_media: thumb ? Number(thumb) : 0
    };
  };

  const POST_COLUMNS =
    'ID, post_date, post_modified, post_content, post_title, post_excerpt, post_status, post_name';

  return {
    async listPosts(listOpts: ListPostsOpts = {}): Promise<ListResult> {
      const page = listOpts.page ?? 1;
      const perPage = Math.min(500, Math.max(1, listOpts.perPage ?? 50));
      const { sql, params } = statusFilter(listOpts.status);
      const where = `post_type = 'post' AND ${sql}`;
      const total =
        db
          .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM wp_posts WHERE ${where}`)
          .get(...params)?.n ?? 0;
      const rows = db
        .prepare<PostRow>(
          `SELECT ${POST_COLUMNS} FROM wp_posts WHERE ${where}
            ORDER BY post_date DESC, ID DESC LIMIT ? OFFSET ?`
        )
        .all(...params, perPage, (page - 1) * perPage);
      return {
        posts: rows.map(toWpPost),
        total,
        totalPages: Math.max(1, Math.ceil(total / perPage))
      };
    },

    async fetchPost(idOrSlug: string | number): Promise<WpPost> {
      const byId = typeof idOrSlug === 'number' || /^\d+$/.test(idOrSlug);
      const row = byId
        ? db
            .prepare<PostRow>(
              `SELECT ${POST_COLUMNS} FROM wp_posts WHERE ID = ? AND post_type = 'post'`
            )
            .get(Number(idOrSlug))
        : db
            .prepare<PostRow>(
              `SELECT ${POST_COLUMNS} FROM wp_posts WHERE post_name = ? AND post_type = 'post'`
            )
            .get(String(idOrSlug));
      if (!row) throw new Error(`no post "${idOrSlug}" in the backup`);
      return toWpPost(row);
    },

    async fetchPage(slug: string): Promise<WpPost> {
      const row = db
        .prepare<PostRow>(
          `SELECT ${POST_COLUMNS} FROM wp_posts WHERE post_name = ? AND post_type = 'page'`
        )
        .get(slug);
      if (!row) throw new Error(`no page "${slug}" in the backup`);
      return toWpPost(row);
    },

    async fetchSiteInfo(): Promise<WpSiteInfo> {
      return { name: option('blogname'), description: option('blogdescription') };
    },

    async fetchSiteBannerUrl(): Promise<string | null> {
      // WP names custom header crops "cropped-<original>"; the newest one
      // is the header currently in use.
      const row = db
        .prepare<{ ID: number; meta_value: string }>(
          `SELECT p.ID AS ID, m.meta_value AS meta_value
             FROM wp_posts p
             JOIN wp_postmeta m ON m.post_id = p.ID AND m.meta_key = '_wp_attached_file'
            WHERE p.post_type = 'attachment'
              AND (m.meta_value LIKE 'cropped-%' OR m.meta_value LIKE '%/cropped-%')
            ORDER BY p.post_date DESC
            LIMIT 1`
        )
        .get();
      if (!row) return null;
      return `${siteUrl()}/wp-content/uploads/${row.meta_value}#wp-image-${row.ID}`;
    },

    async fetchFeaturedMediaUrl(mediaId: number): Promise<string | null> {
      if (!mediaId) return null;
      const file = attachedFile(mediaId);
      if (!file) return null;
      return `${siteUrl()}/wp-content/uploads/${file}#wp-image-${mediaId}`;
    },

    async listComments(commentOpts: ListCommentsOpts = {}): Promise<CommentListResult> {
      const page = commentOpts.page ?? 1;
      const perPage = Math.min(500, Math.max(1, commentOpts.perPage ?? 100));
      // REST returns reader comments only; '' is the pre-4.x spelling of 'comment'.
      const where = "comment_approved = '1' AND comment_type IN ('', 'comment')";
      const total =
        db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM wp_comments WHERE ${where}`).get()
          ?.n ?? 0;
      const rows = db
        .prepare<CommentRow>(
          `SELECT comment_ID, comment_post_ID, comment_parent, comment_author,
                  comment_author_url, comment_date, comment_content
             FROM wp_comments WHERE ${where}
            ORDER BY comment_date ASC, comment_ID ASC LIMIT ? OFFSET ?`
        )
        .all(perPage, (page - 1) * perPage);
      const comments: WpComment[] = rows.map((r) => ({
        id: r.comment_ID,
        post: r.comment_post_ID,
        parent: r.comment_parent,
        author_name: r.comment_author,
        author_url: r.comment_author_url,
        date: isoDate(r.comment_date),
        content: { rendered: r.comment_content }
      }));
      return { comments, total, totalPages: Math.max(1, Math.ceil(total / perPage)) };
    },

    fetchImage(url: string): Promise<Readable> {
      return fetchImage(url);
    },

    async fetchTagNames(tagIds: number[]): Promise<string[]> {
      if (tagIds.length === 0) return [];
      const placeholders = tagIds.map(() => '?').join(',');
      return db
        .prepare<{ name: string }>(
          `SELECT name FROM wp_terms WHERE term_id IN (${placeholders}) ORDER BY term_id`
        )
        .all(...tagIds)
        .map((r) => r.name);
    },

    close(): void {
      db.close();
    }
  };
}
