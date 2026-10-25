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

/** Read one page by slug. Returns null for missing, malformed, or
 * path-traversal slugs — a bad file on disk is a 404, not a 500. */
export function readBlockPage(siteRoot: string, slug: string): BlockPage | null {
  if (!VALID_SLUG.test(slug)) return null;
  const dir = path.join(siteRoot, 'content', 'blocks');
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const file of files.sort()) {
    if (!file.endsWith('.json')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
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
    return { title, tree, fields: parsed.fields };
  }
  return null;
}

/** The file that stores `slug`: `<slug>.json` if present, else the file whose
 * `fields.slug` matches (migrated pages carry a dated name). The scan only
 * runs when the plain name is missing, so a page found once is a direct hit
 * on every later save. */
export function findBlockFile(siteRoot: string, slug: string): string | null {
  const dir = path.join(siteRoot, 'content', 'blocks');
  const direct = path.join(dir, `${slug}.json`);
  if (fs.existsSync(direct)) return direct;
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const file of files.sort()) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (isRecord(parsed) && isRecord(parsed.fields) && parsed.fields.slug === slug) {
        return path.join(dir, file);
      }
    } catch {
      // unrelated or malformed file
    }
  }
  return null;
}
