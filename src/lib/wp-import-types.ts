// Shared types between the WP importer (lib/wp-import.ts) and the
// REST client (lib/wp-rest.ts). Splitting the type out avoids a cycle
// (wp-rest.ts → wp-import.ts → wp-rest.ts) once the importer needs to
// re-export the type for backward compatibility.

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
