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
