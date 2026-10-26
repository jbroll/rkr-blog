// Stored JSON pages (experimental blocks format). One file per page
// under `<siteRoot>/content/blocks/`; the URL slug matches the page's
// `fields.slug`, not the filename, so dated filenames from
// `import-wp --as-blocks` and plain names from `blocks-migrate` both
// work. Corrupt files are skipped, never thrown.

import fs from 'node:fs';
import path from 'node:path';

import { type BlockTree, parseBlockTree } from './blocks.ts';

const VALID_SLUG = /^[a-z0-9-]+$/;

export interface BlockPage {
  title: string;
  tree: BlockTree;
  fields: Record<string, unknown>;
  /** Changes whenever the file is rewritten; the editor's save sends it
   * back so a stale save is refused. */
  version: string;
}

/** Version of a stored page file (its mtime, as a string). */
export function blockFileVersion(file: string): string {
  return String(fs.statSync(file).mtimeMs);
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

/** The one slug-to-file rule: the first file, in sorted name order, whose
 * `fields.slug` equals the slug and whose tree parses. A `<slug>.json` with
 * a different `fields.slug` does not match. */
function resolveBlockPage(siteRoot: string, slug: string): ResolvedPage | null {
  if (!VALID_SLUG.test(slug)) return null;
  const dir = path.join(siteRoot, 'content', 'blocks');
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of files.sort()) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.fields) || parsed.fields.slug !== slug) continue;
    let tree: BlockTree;
    try {
      tree = parseBlockTree({ version: 1, body: parsed.body });
    } catch {
      continue;
    }
    const title = typeof parsed.fields.title === 'string' ? parsed.fields.title : slug;
    return { title, tree, fields: parsed.fields, file, version: blockFileVersion(file) };
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
