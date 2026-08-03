// Resolve a WordPress <img src> to a file in a backup's uploads tree.
// Preferred route is the attachment id the importer appends to the URL
// as `#wp-image-<id>`: `_wp_attached_file` names the full-size original,
// while the markup usually points at a resized variant.

import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';

import type { Db } from './db.ts';

interface MetaRow {
  meta_value: string;
}

function realpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Canonical path for `candidate` under `root`, or null when it is
 * missing or lands outside the tree. Both the dump's
 * `_wp_attached_file` values and the uploads tree itself come from an
 * untrusted backup, so a `..` segment and a symlink pointing out of the
 * tree have to be caught; comparing realpaths catches a link at any
 * segment, not just the last. */
function within(root: string, candidate: string): string | null {
  const realRoot = realpath(root);
  if (realRoot === null) return null;
  const real = realpath(path.resolve(realRoot, candidate));
  if (real === null) return null;
  const rel = path.relative(realRoot, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return real;
}

function decodePath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** Path under the uploads tree for a WP image URL, or null if none
 * resolves. Tries the `#wp-image-<id>` attachment first, then the URL's
 * own path with WP's `-<W>x<H>` size suffix stripped, then verbatim. */
export function resolveAttachmentPath(db: Db, uploadsRoot: string, url: string): string | null {
  const idMatch = /#wp-image-(\d+)$/.exec(url);
  if (idMatch) {
    const row = db
      .prepare<MetaRow>(
        "SELECT meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key = '_wp_attached_file'"
      )
      .get(Number(idMatch[1]));
    if (row?.meta_value) {
      const p = within(uploadsRoot, row.meta_value);
      if (p !== null) return p;
    }
  }

  const bare = url.replace(/#.*$/, '');
  const uploadsRel = /\/wp-content\/uploads\/(.+)$/.exec(bare)?.[1];
  if (!uploadsRel) return null;
  const decoded = decodePath(uploadsRel);

  const stripped = decoded.replace(/-\d+x\d+(\.[A-Za-z0-9]+)$/, '$1');
  for (const candidate of [stripped, decoded]) {
    const p = within(uploadsRoot, candidate);
    if (p !== null) return p;
  }
  return null;
}

/** An `importPost` / `pushPost` compatible image fetcher that streams
 * from the backup's uploads tree instead of the network. */
export function sqliteImageFetcher(
  db: Db,
  uploadsRoot: string
): (url: string) => Promise<Readable> {
  return async (url: string) => {
    const file = resolveAttachmentPath(db, uploadsRoot, url);
    if (file === null) throw new Error(`image not in the backup uploads tree: ${url}`);
    return fs.createReadStream(file);
  };
}
