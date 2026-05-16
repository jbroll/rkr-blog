// Helpers for POST /admin/reset — extracted to keep admin.ts under the
// 500-line cap. Not intended for use outside the admin reset route.

import fs from 'node:fs';
import path from 'node:path';

export interface ResetCounts {
  posts: number;
  originals: number;
  sidecars: number;
  cacheFiles: number;
  postsTableRows: number;
}

/**
 * Recursively walk a directory: unlink every regular file, then rmdir
 * every now-empty INNER subdirectory (leaves up to root). The top-level
 * `dir` itself is preserved so a Fly volume mount point — which can't
 * be unlinked — stays in place. Returns the count of files removed.
 *
 * Two passes by design:
 *   1. forward (stack) walk to unlink files and enumerate subdirs
 *   2. reverse walk to rmdir each inner subdir (leaves first), best-
 *      effort — a non-empty dir or transient EBUSY is silently skipped
 *
 * Without the rmdir pass the originals/sidecars/cache trees accumulate
 * empty shard subdirs (originals/aa/bb/) after every reset; cosmetic
 * but they leak directory entries indefinitely on a long-lived demo.
 */
async function wipeDirectoryContents(dir: string): Promise<number> {
  /* c8 ignore next */
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  const visitedDirs: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
      /* c8 ignore next 2 */
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        visitedDirs.push(full);
      } else {
        try {
          await fs.promises.unlink(full);
          count++;
          /* c8 ignore next 2 */
        } catch {
          // best-effort: a transient EBUSY etc. shouldn't abort the wipe
        }
      }
    }
  }
  // Reverse-order rmdir so leaf subdirs go first; the top-level `dir`
  // is excluded from visitedDirs so it's never touched.
  for (const sub of visitedDirs.reverse()) {
    try {
      await fs.promises.rmdir(sub);
      /* c8 ignore next 2 */
    } catch {
      // non-empty (concurrent write) or EBUSY: harmless to skip
    }
  }
  return count;
}

export async function wipeRuntimeData(siteRoot: string): Promise<ResetCounts> {
  const postsDir = path.join(siteRoot, 'content', 'posts');
  const originalsDir = path.join(siteRoot, 'originals');
  const sidecarsDir = path.join(siteRoot, 'sidecars');
  const cacheImgDir = path.join(siteRoot, 'cache', 'img');

  const posts = await wipeDirectoryContents(postsDir);
  const originals = await wipeDirectoryContents(originalsDir);
  const sidecars = await wipeDirectoryContents(sidecarsDir);
  const cacheFiles = await wipeDirectoryContents(cacheImgDir);

  // Truncate the posts + render-job tables. Users and sessions are
  // intentionally untouched — the operator stays signed in. The DB
  // file itself stays so the migrations don't need to re-run.
  const dbPath = path.join(siteRoot, 'data', 'site.db');
  let postsTableRows = 0;
  if (fs.existsSync(dbPath)) {
    const db = (await import('../lib/db.ts')).open(dbPath);
    try {
      const before = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM posts').get();
      postsTableRows = before?.n ?? 0;
      db.exec('DELETE FROM posts');
      // The render queue (jobs table) may carry references to images
      // we just deleted; clear it so background workers don't churn
      // on missing files.
      db.exec('DELETE FROM jobs');
    } finally {
      db.close();
    }
  }
  return { posts, originals, sidecars, cacheFiles, postsTableRows };
}
