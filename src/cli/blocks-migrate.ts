// `site-admin blocks-migrate --post <slug> [--out <file>]` — convert one
// markdown post to a JSON block tree. Prints pretty-printed JSON to
// stdout, or writes it to --out. Read-only: the markdown source is
// never modified.

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
  console.error('usage: site-admin blocks-migrate --post <slug> [--out <file>] | --all');
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

export default async function blocksMigrateCmd(argv: string[]): Promise<void> {
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
