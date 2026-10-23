// `site-admin blocks-migrate --post <slug> [--out <file>]` — convert one
// markdown post to a JSON block tree. Prints pretty-printed JSON to
// stdout, or writes it to --out. Read-only: the markdown source is
// never modified (except by --archive, which moves sources out of the
// read path rather than deleting them).

import fs from 'node:fs';
import path from 'node:path';

import { paths } from '../lib/config.ts';
import { type MigratedTree, migratePostToTree } from '../lib/markdown-migrate.ts';
import { listPosts } from '../lib/posts.ts';

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
    'usage: site-admin blocks-migrate --post <slug> [--out <file>] | --all | --archive [--include-untwinned]'
  );
  process.exit(2);
}

/** Convert every markdown post to its JSON twin in content/blocks,
 * mirroring the markdown basename. Returns the written files. A post
 * that fails to parse is skipped and reported, never half-written. */
export function runBlocksMigrateAll(siteRoot: string): { slug: string; file: string }[] {
  const postsDir = path.join(siteRoot, 'content', 'posts');
  const blocksDir = path.join(siteRoot, 'content', 'blocks');
  fs.mkdirSync(blocksDir, { recursive: true });
  const written: { slug: string; file: string }[] = [];
  for (const post of listPosts(siteRoot)) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(postsDir, post.filename), 'utf8');
    } catch {
      continue;
    }
    let tree: MigratedTree;
    try {
      tree = migratePostToTree(raw);
    } catch (err) {
      console.error(`blocks-migrate: skip ${post.slug}: ${(err as Error).message}`);
      continue;
    }
    const dest = path.join(blocksDir, `${post.filename.replace(/\.md$/, '')}.json`);
    fs.writeFileSync(dest, `${JSON.stringify(tree, null, 2)}\n`);
    written.push({ slug: tree.fields.slug, file: dest });
  }
  return written.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

export interface ArchivedPost {
  slug: string;
  file: string;
}

/** Slugs carried by the JSON pages in content/blocks/. Corrupt or
 * malformed files are not twins — they cannot keep a post readable. */
function listBlockSlugs(blocksDir: string): Set<string> {
  const slugs = new Set<string>();
  if (!fs.existsSync(blocksDir)) return slugs;
  for (const file of fs.readdirSync(blocksDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(blocksDir, file), 'utf8')) as {
        fields?: { slug?: unknown };
      };
      const slug = parsed.fields?.slug;
      if (typeof slug === 'string' && slug) slugs.add(slug);
    } catch {
      // Unreadable twin: leave the markdown in place.
    }
  }
  return slugs;
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
  opts: { includeUntwinned?: boolean } = {}
): ArchivedPost[] {
  const postsDir = path.join(siteRoot, 'content', 'posts');
  const legacyDir = path.join(siteRoot, 'content', 'posts-legacy');
  const posts = listPosts(siteRoot).filter(
    (p) => !p.filename.startsWith('_') && !p.slug.startsWith('_')
  );
  const twinSlugs = listBlockSlugs(path.join(siteRoot, 'content', 'blocks'));

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

  fs.mkdirSync(legacyDir, { recursive: true });
  const moved: ArchivedPost[] = [];
  for (const post of posts) {
    const dest = path.join(legacyDir, post.filename);
    fs.renameSync(path.join(postsDir, post.filename), dest);
    moved.push({ slug: post.slug, file: dest });
  }
  return moved.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

export default async function blocksMigrateCmd(argv: string[]): Promise<void> {
  if (argv.includes('--archive')) {
    const moved = runBlocksArchive(paths().root, {
      includeUntwinned: argv.includes('--include-untwinned')
    });
    console.log(`blocks-migrate: moved ${moved.length} markdown file(s) to content/posts-legacy/`);
    for (const m of moved) console.log(`  ${m.slug}`);
    console.log('blocks-migrate: run `site-admin reindex` to refresh the index');
    return;
  }
  if (argv.includes('--all')) {
    const written = runBlocksMigrateAll(paths().root);
    console.log(`blocks-migrate: wrote ${written.length} JSON twin(s) to content/blocks/`);
    for (const w of written) console.log(`  ${w.slug}`);
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
