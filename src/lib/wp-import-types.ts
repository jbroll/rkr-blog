// Shared types for the WP import pipeline. Split from lib/wp-import.ts
// so the REST client (lib/wp-rest.ts) and the HTML→markdown emitter
// (lib/wp-import-emit.ts) can pull just the types they need.

/** Subset of WP /wp-json/wp/v2/posts response we depend on. */
export interface WpPost {
  id: number;
  date: string; // ISO-8601 (server local; we treat as UTC for filenames)
  modified: string;
  slug: string;
  status: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt: { rendered: string };
  link: string;
  categories?: number[];
  tags?: number[];
  /** WP featured image media ID, if set. Resolved to a URL via the
   * /wp-json/wp/v2/media/{id} endpoint during import. */
  featured_media?: number;
}

/** Subset of WP /wp-json/wp/v2/comments we depend on for recovery. */
export interface WpComment {
  id: number;
  post: number; // WP post id
  parent: number; // 0 = top-level
  author_name: string;
  author_url: string;
  date: string; // ISO-8601, server local
  content: { rendered: string };
}

/** Minimal hast (HTML AST) node shape we walk during import. rehype-parse
 * produces fuller nodes; we only access these fields. */
export interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}
