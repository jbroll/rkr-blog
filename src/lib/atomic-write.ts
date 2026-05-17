// Atomic file replace. fs.writeFile opens with O_TRUNC: it zeroes the
// target, then streams the new bytes — so a concurrent reader (e.g. the
// public GET /:slug or GET /about handler, which reads the post file
// fresh per request) can observe an empty or half-written file and
// parse-fail, surfacing a transient 404 on a published page during an
// author save. Writing a sibling temp file then rename()ing it over the
// target closes that window: rename(2) within one directory (same
// filesystem) is atomic, so a reader always sees either the complete
// old file or the complete new one — never absent or partial.

import fs from 'node:fs';
import path from 'node:path';

/** Atomically replace `filePath` with `data` (utf8). The temp file is a
 * sibling (same directory ⇒ same filesystem ⇒ atomic rename). On any
 * error the temp file is removed and `filePath` is left untouched. */
function tmpPathFor(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`
  );
}

export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const tmp = tmpPathFor(filePath);
  try {
    await fs.promises.writeFile(tmp, data, 'utf8');
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

/** Synchronous twin of {@link writeFileAtomic}, for the many sync
 * callers (config/site.json, system-post stubs, import CLIs) that
 * would otherwise need an async refactor. Same temp+rename guarantee. */
export function writeFileAtomicSync(filePath: string, data: string): void {
  const tmp = tmpPathFor(filePath);
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
