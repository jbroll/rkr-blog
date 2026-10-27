// Stored JSON pages (experimental blocks format). One file per page
// under `<siteRoot>/content/blocks/`; the URL slug matches the page's
// `fields.slug`, not the filename, so dated filenames from
// `import-wp --as-blocks` and plain names from `blocks-migrate` both
// work. Corrupt files are skipped, never thrown.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { type BlockTree, parseBlockTree } from './blocks.ts';

const VALID_SLUG = /^[a-z0-9-]+$/;

/** Pages the editor routes open although the slug starts with `_`. Public
 * routes and the indexer keep refusing every `_` slug. */
export const SYSTEM_SLUGS: ReadonlySet<string> = new Set(['_footer']);

export const isEditableSlug = (slug: string): boolean =>
  VALID_SLUG.test(slug) || SYSTEM_SLUGS.has(slug);

export interface BlockPage {
  title: string;
  tree: BlockTree;
  fields: Record<string, unknown>;
  /** Changes whenever the file's contents change; the editor's save sends
   * it back so a stale save is refused. */
  version: string;
}

// A content hash, not mtime: two writes inside one timestamp tick would
// share an mtime and let a stale save through.
const contentVersion = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 16);

/** Version of a stored page file. */
export function blockFileVersion(file: string): string {
  return contentVersion(fs.readFileSync(file));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Every stored page, sorted by slug. Corrupt files are skipped. */
export function listBlockPages(siteRoot: string): { slug: string; title: string }[] {
  const dir = path.join(siteRoot, 'content', 'blocks');
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: { slug: string; title: string }[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.json')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.fields)) continue;
    if (typeof parsed.fields.slug !== 'string' || !VALID_SLUG.test(parsed.fields.slug)) continue;
    try {
      parseBlockTree({ version: 1, body: parsed.body });
    } catch {
      continue;
    }
    out.push({
      slug: parsed.fields.slug,
      title: typeof parsed.fields.title === 'string' ? parsed.fields.title : parsed.fields.slug
    });
  }
  return out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

interface ResolvedPage extends BlockPage {
  file: string;
}

/** One page file, when it parses and carries `slug`. */
function readPageFile(file: string, slug: string): ResolvedPage | null {
  let parsed: unknown;
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.fields) || parsed.fields.slug !== slug) return null;
  let tree: BlockTree;
  try {
    tree = parseBlockTree({ version: 1, body: parsed.body });
  } catch {
    return null;
  }
  const title = typeof parsed.fields.title === 'string' ? parsed.fields.title : slug;
  return { title, tree, fields: parsed.fields, file, version: contentVersion(bytes) };
}

/** The one slug-to-file rule: a system slug reads only `<slug>.json`;
 * any other slug takes the first file, in sorted name order, whose
 * `fields.slug` equals the slug and whose tree parses. A `<slug>.json` with
 * a different `fields.slug` does not match. */
function resolveBlockPage(siteRoot: string, slug: string): ResolvedPage | null {
  if (!isEditableSlug(slug)) return null;
  const dir = path.join(siteRoot, 'content', 'blocks');
  if (SYSTEM_SLUGS.has(slug)) return readPageFile(path.join(dir, `${slug}.json`), slug);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of files.sort()) {
    if (!name.endsWith('.json')) continue;
    const page = readPageFile(path.join(dir, name), slug);
    if (page) return page;
  }
  return null;
}

/** Read one page by slug. Returns null for missing, malformed, or
 * path-traversal slugs — a bad file on disk is a 404, not a 500. */
export function readBlockPage(siteRoot: string, slug: string): BlockPage | null {
  const page = resolveBlockPage(siteRoot, slug);
  return page && { title: page.title, tree: page.tree, fields: page.fields, version: page.version };
}

/** Path of the file `readBlockPage` serves for `slug`, so a save lands on it. */
export function findBlockFile(siteRoot: string, slug: string): string | null {
  return resolveBlockPage(siteRoot, slug)?.file ?? null;
}

/** The page an index row points at. A row under content/blocks/ names its
 * file, so it is read directly when that file still carries the slug;
 * any other row (a twin whose markdown is still on disk) resolves by slug. */
export function readIndexedBlockPage(
  siteRoot: string,
  row: { slug: string; path: string }
): BlockPage | null {
  if (path.posix.dirname(row.path) === 'content/blocks' && VALID_SLUG.test(row.slug)) {
    const page = readPageFile(path.join(siteRoot, row.path), row.slug);
    if (page)
      return { title: page.title, tree: page.tree, fields: page.fields, version: page.version };
  }
  return readBlockPage(siteRoot, row.slug);
}
