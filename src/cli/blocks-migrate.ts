// `site-admin blocks-migrate --post <slug> [--out <file>]` — convert one
// markdown post to a JSON block tree. Prints pretty-printed JSON to
// stdout, or writes it to --out. Read-only: the markdown source is
// never modified.

import fs from 'node:fs';
import path from 'node:path';

import { paths } from '../lib/config.ts';
import { listPosts } from '../lib/posts.ts';
import { migratePostToTree, type MigratedTree } from '../lib/markdown-migrate.ts';

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
  console.error('usage: site-admin blocks-migrate --post <slug> [--out <file>]');
  process.exit(2);
}

export default async function blocksMigrateCmd(argv: string[]): Promise<void> {
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
