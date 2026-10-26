// `site-admin blocks-migrate --post <slug> [--out <file>]` — convert one
// markdown post to a JSON block tree. Prints pretty-printed JSON to
// stdout, or writes it to --out. Read-only: the markdown source is
// never modified (except by --archive, which moves sources out of the
// read path rather than deleting them).

import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomicSync } from '../lib/atomic-write.ts';
import { findBlockFile } from '../lib/block-pages.ts';
import { paths } from '../lib/config.ts';
import { type MigratedTree, migratePostToTree } from '../lib/markdown-migrate.ts';
import { indexableBlockSlugs } from '../lib/post-index-blocks.ts';
import { listPosts } from '../lib/posts.ts';
import { RESERVED_SLUGS } from '../lib/reserved-slugs.ts';

/** Read one post's markdown and convert it. Throws when no post file
 * carries the slug. */
export function runBlocksMigrate(siteRoot: string, slug: string): MigratedTree {
  const postsDir = path.join(siteRoot, 'content', 'posts');
  const posts = listPosts(siteRoot);
  const match = posts.find((p) => p.slug === slug);
  if (!match) throw new Error(`blocks-migrate: no post with slug ${slug}`);
  const raw = fs.readFileSync(path.join(postsDir, match.filename), 'utf8');
  return migratePostToTree(raw);
}

function usage(): never {
  console.error(
    'usage: site-admin blocks-migrate --post <slug> [--out <file>] | --all [--force] [--dry-run] | --archive [--include-untwinned] [--dry-run]'
  );
  process.exit(2);
}

export interface MigrateAllOpts {
  /** Overwrite a page the slug already resolves to. */
  force?: boolean;
  /** Report what would be written; write nothing. */
  dryRun?: boolean;
  /** Skip and warning lines; defaults to stderr. */
  log?: (line: string) => void;
}

// Seconds precision, the shape imported and editor-saved dates use.
const isoSeconds = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Convert every markdown post to its JSON twin in content/blocks,
 * mirroring the markdown basename. Returns the files written (or, on a
 * dry run, that would be). A slug that already resolves to a page is
 * skipped unless forced, so a rerun never overwrites editor work; system
 * (`_`) posts are never converted. A post that fails to parse is skipped
 * and reported, never half-written. The twin keeps the markdown's mtime,
 * and an undated published post gets that mtime as its date, so index
 * order and dates do not move. */
export function runBlocksMigrateAll(
  siteRoot: string,
  opts: MigrateAllOpts = {}
): { slug: string; file: string }[] {
  const log = opts.log ?? ((line: string) => console.error(line));
  const postsDir = path.join(siteRoot, 'content', 'posts');
  const blocksDir = path.join(siteRoot, 'content', 'blocks');
  if (!opts.dryRun) fs.mkdirSync(blocksDir, { recursive: true });
  const written: { slug: string; file: string }[] = [];
  for (const post of listPosts(siteRoot)) {
    if (post.slug.startsWith('_') || post.filename.startsWith('_')) continue;
    const source = path.join(postsDir, post.filename);
    let raw: string;
    try {
      raw = fs.readFileSync(source, 'utf8');
    } catch {
      continue;
    }
    let tree: MigratedTree;
    try {
      tree = migratePostToTree(raw);
    } catch (err) {
      log(`blocks-migrate: skip ${post.slug}: ${(err as Error).message}`);
      continue;
    }
    const existing = findBlockFile(siteRoot, tree.fields.slug);
    if (existing && !opts.force) {
      log(`blocks-migrate: skip ${tree.fields.slug}: ${path.basename(existing)} already exists`);
      continue;
    }
    if (RESERVED_SLUGS.has(tree.fields.slug)) {
      log(
        `blocks-migrate: warning: "${tree.fields.slug}" is a reserved slug; a fixed route answers its URL, so the page is unreachable or unsavable`
      );
    }
    const { mtime } = fs.statSync(source);
    if (tree.fields.date === undefined && tree.fields.status !== 'draft') {
      tree.fields.date = isoSeconds(mtime.getTime());
    }
    const dest = existing ?? path.join(blocksDir, `${post.filename.replace(/\.md$/, '')}.json`);
    if (!opts.dryRun) {
      writeFileAtomicSync(dest, `${JSON.stringify(tree, null, 2)}\n`);
      fs.utimesSync(dest, mtime, mtime);
    }
    written.push({ slug: tree.fields.slug, file: dest });
  }
  return written.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

export interface ArchivedPost {
  slug: string;
  file: string;
}

/** Move every non-system markdown post from content/posts/ to
 * content/posts-legacy/ so the JSON twin becomes the only readable
 * source. `_`-prefixed system pages (_about, _site-banner) stay live:
 * their public routes read them directly and have no JSON fallback.
 *
 * Validation runs before the first move: an untwinned post refuses the
 * whole archive unless includeUntwinned is set, and a name already in
 * the legacy directory is never overwritten. Files are moved, never
 * copied or deleted. */
export function runBlocksArchive(
  siteRoot: string,
  opts: { includeUntwinned?: boolean; dryRun?: boolean } = {}
): ArchivedPost[] {
  const postsDir = path.join(siteRoot, 'content', 'posts');
  const legacyDir = path.join(siteRoot, 'content', 'posts-legacy');
  const posts = listPosts(siteRoot).filter(
    (p) => !p.filename.startsWith('_') && !p.slug.startsWith('_')
  );
  // Only a twin the index accepts keeps the post readable after the move.
  const twinSlugs = indexableBlockSlugs(path.join(siteRoot, 'content', 'blocks'));

  const untwinned = posts.filter((p) => !twinSlugs.has(p.slug));
  if (untwinned.length > 0 && !opts.includeUntwinned) {
    throw new Error(
      `blocks-migrate archive: no JSON twin for ${untwinned
        .map((p) => `${p.slug} (${p.filename})`)
        .join(', ')} — run \`blocks-migrate --all\` first, or pass --include-untwinned`
    );
  }

  const collisions = posts.filter((p) => fs.existsSync(path.join(legacyDir, p.filename)));
  if (collisions.length > 0) {
    throw new Error(
      `blocks-migrate archive: already archived: ${collisions
        .map((p) => p.filename)
        .join(', ')} — resolve content/posts-legacy/ first (nothing was moved)`
    );
  }

  if (!opts.dryRun) fs.mkdirSync(legacyDir, { recursive: true });
  const moved: ArchivedPost[] = [];
  for (const post of posts) {
    const dest = path.join(legacyDir, post.filename);
    if (!opts.dryRun) fs.renameSync(path.join(postsDir, post.filename), dest);
    moved.push({ slug: post.slug, file: dest });
  }
  return moved.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

export default async function blocksMigrateCmd(argv: string[]): Promise<void> {
  const dryRun = argv.includes('--dry-run');
  if (argv.includes('--archive')) {
    const moved = runBlocksArchive(paths().root, {
      includeUntwinned: argv.includes('--include-untwinned'),
      dryRun
    });
    console.log(
      `blocks-migrate: ${dryRun ? 'would move' : 'moved'} ${moved.length} markdown file(s) to content/posts-legacy/`
    );
    for (const m of moved) console.log(`  ${m.slug}  ${path.basename(m.file)}`);
    if (!dryRun) console.log('blocks-migrate: run `site-admin reindex` to refresh the index');
    return;
  }
  if (argv.includes('--all')) {
    const written = runBlocksMigrateAll(paths().root, { force: argv.includes('--force'), dryRun });
    console.log(
      `blocks-migrate: ${dryRun ? 'would write' : 'wrote'} ${written.length} JSON twin(s) to content/blocks/`
    );
    for (const w of written) console.log(`  ${w.slug}  ${path.basename(w.file)}`);
    return;
  }
  const postIdx = argv.indexOf('--post');
  const slug = postIdx >= 0 ? argv[postIdx + 1] : undefined;
  if (!slug) usage();
  const outIdx = argv.indexOf('--out');
  const out = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  if (outIdx >= 0 && !out) usage();
  const tree = runBlocksMigrate(paths().root, slug as string);
  const json = `${JSON.stringify(tree, null, 2)}\n`;
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json);
  } else console.log(json);
}
