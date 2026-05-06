// Helpers used by `site-admin render` / `gc` / `verify` to enumerate sidecars
// and resolve --post <slug> filters. Full markdown directive parsing arrives
// in Step 5; for Step 4 we use a lightweight scanner that pulls 64-hex ids
// out of `::image{id=...}` and `::gallery{ids=[...]}` directive markers.

import fs from 'node:fs';
import path from 'node:path';

import { type Sidecar, read as sidecarRead } from './sidecar.ts';

/** Iterate every sidecar id present in $SITE_ROOT/sidecars/. */
export function listSidecarIds(siteRoot: string): string[] {
  const dir = path.join(siteRoot, 'sidecars');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .filter((id) => /^[0-9a-f]{64}$/.test(id));
}

/** Read every sidecar present in $SITE_ROOT/sidecars/, in id order. */
export async function listSidecars(siteRoot: string): Promise<Sidecar[]> {
  const ids = listSidecarIds(siteRoot).sort();
  const out: Sidecar[] = [];
  for (const id of ids) {
    const s = await sidecarRead(siteRoot, id);
    if (s) out.push(s);
  }
  return out;
}

const ID_RE = /\b[0-9a-f]{64}\b/g;
const SHORT_ID_RE = /\b[0-9a-f]{6,64}\b/g;

/**
 * Lightweight scanner for image references in a post's markdown body.
 * Handles the directive forms:
 *   ::image{id=<hex>}
 *   ::gallery{ids=[<hex>,<hex>,...]}
 * Full mdast directive parsing replaces this in Step 5.
 *
 * Accepts ids of 6-64 hex chars to allow short prefixes; short ids are
 * resolved against the supplied set of full ids.
 */
export function scanPostForImageIds(body: string, knownIds: Set<string>): Set<string> {
  const refs = new Set<string>();

  // First pass: full 64-hex ids.
  for (const m of body.matchAll(ID_RE)) {
    if (knownIds.has(m[0])) refs.add(m[0]);
  }

  // Second pass: short ids → resolve to full id by prefix match.
  const fulls = [...knownIds];
  for (const m of body.matchAll(SHORT_ID_RE)) {
    const candidate = m[0];
    if (candidate.length === 64) continue; // already handled above
    const matches = fulls.filter((id) => id.startsWith(candidate));
    if (matches.length === 1) {
      const sole = matches[0];
      if (sole !== undefined) refs.add(sole);
    }
    // Ambiguous prefixes are silently ignored — Step 5's directive parser
    // surfaces them as authoring errors.
  }

  return refs;
}

export interface PostFile {
  slug: string;
  filename: string;
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
const SLUG_RE = /^slug:\s*(.+?)\s*$/m;

/** Read all posts from $SITE_ROOT/content/posts/*.md. */
export function listPosts(siteRoot: string): PostFile[] {
  const dir = path.join(siteRoot, 'content', 'posts');
  if (!fs.existsSync(dir)) return [];
  const out: PostFile[] = [];
  for (const filename of fs.readdirSync(dir)) {
    if (!filename.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(dir, filename), 'utf8');
    const m = FRONTMATTER_RE.exec(raw);
    let slug: string | undefined;
    let body = raw;
    if (m) {
      const sm = SLUG_RE.exec(m[1] as string);
      if (sm) slug = sm[1];
      body = m[2] as string;
    }
    if (!slug) {
      // Fall back to filename minus optional date prefix.
      slug = filename.replace(/^(\d{4}-\d{2}-\d{2}-)?/, '').replace(/\.md$/, '');
    }
    out.push({ slug, filename, body });
  }
  return out;
}

/**
 * Find the set of sidecar ids referenced by a single post slug.
 * Returns null if no post matches that slug.
 */
export function imageIdsForPost(siteRoot: string, slug: string): Set<string> | null {
  const posts = listPosts(siteRoot);
  const post = posts.find((p) => p.slug === slug);
  if (!post) return null;
  const known = new Set(listSidecarIds(siteRoot));
  return scanPostForImageIds(post.body, known);
}
