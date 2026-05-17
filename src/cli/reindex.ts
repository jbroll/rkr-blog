// `site-admin reindex` — rebuild the posts table from the markdown files
// under content/posts/. The filesystem is the source of truth; the table
// is just an index for fast `GET /` and `GET /:slug` queries. The index
// logic itself lives in lib/post-index.ts; this file is just the CLI glue.

import { paths } from '../lib/config.ts';
import { runReindex } from '../lib/post-index.ts';

export default async function reindexCmd(_argv: string[]): Promise<void> {
  const r = runReindex(paths().root);
  console.log(
    `reindex: ${r.inserted + r.updated} indexed (${r.inserted} new, ${r.updated} updated, ${r.removed} removed)`
  );
}
