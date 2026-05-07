// `site-admin import-wp {list,post}` — import posts from a WordPress
// blog via its REST API. See lib/wp-import.ts for the heavy lifting.

import fs from 'node:fs';
import path from 'node:path';

import { paths } from '../lib/config.ts';
import { fetchPost, importPost, listPosts } from '../lib/wp-import.ts';

const SUBCOMMANDS = ['list', 'post'] as const;
type Sub = (typeof SUBCOMMANDS)[number];

export default async function importWpCmd(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new Error(
      `usage:\n  site-admin import-wp list <base-url> [--page N] [--per-page N] [--status STATUS]\n  site-admin import-wp post <base-url> <id-or-slug> [--force]`
    );
  }
  if ((sub as Sub) === 'list') return list(argv.slice(1));
  return post(argv.slice(1));
}

async function list(args: string[]): Promise<void> {
  const baseUrl = args[0];
  if (!baseUrl) throw new Error('usage: site-admin import-wp list <base-url> [--page N]');
  const page = numberFlag(args, '--page') ?? 1;
  const perPage = numberFlag(args, '--per-page') ?? 50;
  const status = stringFlag(args, '--status') ?? 'publish';

  const r = await listPosts(baseUrl, { page, perPage, status });
  console.log(`# ${r.total} posts (page ${page}/${r.totalPages})`);
  for (const p of r.posts) {
    const date = p.date.slice(0, 10);
    const title = decodeEntities(p.title.rendered);
    console.log(`${String(p.id).padStart(5)}  ${date}  ${p.slug.padEnd(40)}  ${title}`);
  }
}

async function post(args: string[]): Promise<void> {
  const baseUrl = args[0];
  const idOrSlug = args[1];
  if (!baseUrl || !idOrSlug) {
    throw new Error('usage: site-admin import-wp post <base-url> <id-or-slug> [--force]');
  }
  const force = args.includes('--force');

  const p = paths();
  const post = await fetchPost(baseUrl, idOrSlug);

  // Skip-if-exists by default. Use --force to overwrite.
  const date = post.date.slice(0, 10);
  const filename = `${date}-${post.slug || `post-${post.id}`}.md`;
  const dest = path.join(p.root, 'content', 'posts', filename);
  if (!force && fs.existsSync(dest)) {
    console.log(`skip: ${filename} already exists (use --force to overwrite)`);
    return;
  }

  console.log(`fetching post ${post.id}: ${decodeEntities(post.title.rendered)}`);
  const result = await importPost(post, { siteRoot: p.root });

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, result.markdown);

  const ok = result.imagesIngested.length;
  const fail = result.imageErrors.length;
  console.log(`wrote ${dest}`);
  console.log(`ingested ${ok} image(s)${fail > 0 ? ` (${fail} failed)` : ''}`);
  for (const e of result.imageErrors) {
    console.warn(`  ! ${e.url}: ${e.error}`);
  }
  console.log(`status: draft — review with the editor before publishing`);
}

// ---- arg helpers ------------------------------------------------------

function numberFlag(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = Number(args[i + 1]);
  if (!Number.isFinite(v)) throw new Error(`${flag} requires a numeric value`);
  return v;
}

function stringFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  return args[i + 1];
}

/** Decode the small set of HTML entities WP returns in `title.rendered`
 * (numeric refs + the standard five). Just enough for human-readable
 * console output; the actual markdown body is decoded by the HAST
 * parser already. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'");
}
