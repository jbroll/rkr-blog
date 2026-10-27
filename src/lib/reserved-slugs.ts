// Slugs a page cannot use. A fixed route answers the page's public URL
// (/<slug>) or its editor URL (/admin/blocks/<slug>), so the page would be
// unreachable or unsavable. test/lib/reserved-slugs.test.ts derives the
// list from the registered routes and fails when a route is added.

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin',
  'health',
  'login',
  'macros',
  'new',
  'posts',
  'search'
]);

/** Fixed routes that serve a page of the same slug when one exists. */
export const PAGE_ROUTE_SLUGS: ReadonlySet<string> = new Set(['about']);
