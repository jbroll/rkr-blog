// `site-admin import-wp {list,post,push}` — import posts from a
// WordPress blog via its REST API. See lib/wp-import.ts for the local
// import + lib/wp-push.ts for the push-to-remote flow.

import fs from 'node:fs';
import path from 'node:path';

import { paths } from '../lib/config.ts';
import { importPost } from '../lib/wp-import.ts';
import { pushPost } from '../lib/wp-push.ts';
import { fetchPost, fetchWpSiteBannerUrl, fetchWpSiteInfo, listPosts } from '../lib/wp-rest.ts';

const SUBCOMMANDS = ['list', 'post', 'push', 'site-banner'] as const;
type ImportWpSub = (typeof SUBCOMMANDS)[number];

export default async function importWpCmd(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new Error(
      `usage:
  site-admin import-wp list <base-url> [--page N] [--per-page N] [--status STATUS]
  site-admin import-wp post <base-url> <id-or-slug> [--force]
  site-admin import-wp push <wp-base-url> <slug> --to <fly-url> [--token TOKEN] [--status STATUS]`
    );
  }
  if ((sub as ImportWpSub) === 'list') return list(argv.slice(1));
  if ((sub as ImportWpSub) === 'push') return push(argv.slice(1));
  if ((sub as ImportWpSub) === 'site-banner') return siteBanner(argv.slice(1));
  return post(argv.slice(1));
}

async function list(args: string[]): Promise<void> {
  const baseUrl = args[0];
  if (!baseUrl) throw new Error('usage: site-admin import-wp list <base-url> [--page N]');
  const page = numberFlag(args, '--page') ?? 1;
  const perPage = numberFlag(args, '--per-page') ?? 50;
  const status = stringFlag(args, '--status') ?? 'publish';

  /* c8 ignore start -- success path makes real HTTP calls; covered by lib/wp-rest tests */
  const r = await listPosts(baseUrl, { page, perPage, status });
  console.log(`# ${r.total} posts (page ${page}/${r.totalPages})`);
  for (const p of r.posts) {
    const date = p.date.slice(0, 10);
    const title = decodeEntities(p.title.rendered);
    console.log(`${String(p.id).padStart(5)}  ${date}  ${p.slug.padEnd(40)}  ${title}`);
  }
  /* c8 ignore stop */
}

async function post(args: string[]): Promise<void> {
  const baseUrl = args[0];
  const idOrSlug = args[1];
  if (!baseUrl || !idOrSlug) {
    throw new Error('usage: site-admin import-wp post <base-url> <id-or-slug> [--force]');
  }
  const force = args.includes('--force');

  /* c8 ignore start -- success path makes real HTTP calls; covered by lib/wp-import tests */
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
  /* c8 ignore stop */
}

async function push(args: string[]): Promise<void> {
  const wpBaseUrl = args[0];
  const slug = args[1];
  if (!wpBaseUrl || !slug) {
    throw new Error(
      'usage: site-admin import-wp push <wp-base-url> <slug> --to <fly-url> [--token TOKEN] [--status STATUS]'
    );
  }
  const toUrl = stringFlag(args, '--to');
  if (!toUrl) throw new Error('--to <fly-url> is required');

  // --token wins; otherwise read ADMIN_TOKEN from env so the caller
  // doesn't have to put the secret on the command line / shell history.
  const token = stringFlag(args, '--token') ?? process.env.ADMIN_TOKEN;
  if (!token) {
    throw new Error('bearer token required: pass --token or set ADMIN_TOKEN env');
  }

  /* c8 ignore start -- success path makes real HTTP calls; covered by lib/wp-push tests */
  const statusFlag = stringFlag(args, '--status');
  const status: 'draft' | 'published' = statusFlag === 'draft' ? 'draft' : 'published';

  console.log(`pushing ${wpBaseUrl} ${slug} → ${toUrl}`);
  const result = await pushPost({ wpBaseUrl, slug, toUrl, token, status });

  console.log(
    `${result.inserted ? 'created' : 'overwrote'} /${result.slug}: ${result.imagesUploaded} image(s)${
      result.imagesFailed > 0 ? `, ${result.imagesFailed} failed` : ''
    }, status=${result.status}`
  );
  /* c8 ignore stop */
}

async function siteBanner(args: string[]): Promise<void> {
  const wpBaseUrl = args[0];
  if (!wpBaseUrl) {
    throw new Error(
      'usage: site-admin import-wp site-banner <wp-base-url> --to <target-url> [--token TOKEN]'
    );
  }
  const toUrl = stringFlag(args, '--to');
  if (!toUrl) throw new Error('--to <target-url> is required');
  const token = stringFlag(args, '--token') ?? process.env.ADMIN_TOKEN;
  if (!token) throw new Error('bearer token required: pass --token or set ADMIN_TOKEN env');

  /* c8 ignore start -- success path makes real HTTP calls */
  const target = toUrl.replace(/\/$/, '');

  // Fetch WP site title and tagline, then push to target.
  console.log(`==> fetching site info from ${wpBaseUrl}`);
  const siteInfo = await fetchWpSiteInfo(wpBaseUrl);
  if (siteInfo.name) {
    const siteRes = await fetch(`${target}/admin/settings/site`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: siteInfo.name, tagline: siteInfo.description })
    });
    if (!siteRes.ok)
      throw new Error(`set site info failed: ${siteRes.status} ${await siteRes.text()}`);
    console.log(`    title: ${siteInfo.name}`);
    if (siteInfo.description) console.log(`    tagline: ${siteInfo.description}`);
  }

  // Fetch and upload site banner image.
  console.log(`==> fetching site banner URL from ${wpBaseUrl}`);
  const bannerUrl = await fetchWpSiteBannerUrl(wpBaseUrl);
  if (!bannerUrl) throw new Error(`no header image found on ${wpBaseUrl}`);
  console.log(`    banner URL: ${bannerUrl}`);

  // Download the banner image bytes.
  const res = await fetch(bannerUrl);
  if (!res.ok || !res.body) throw new Error(`banner fetch failed: ${res.status} ${bannerUrl}`);

  // Upload to the target site.
  const filename = bannerUrl.split('/').pop() ?? 'banner.jpg';
  const fd = new FormData();
  fd.append('file', new Blob([await res.arrayBuffer()]), filename);
  const upRes = await fetch(`${target}/admin/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: fd
  });
  if (!upRes.ok) throw new Error(`upload failed: ${upRes.status} ${await upRes.text()}`);
  const { id } = (await upRes.json()) as { id: string };
  console.log(`    uploaded: ${id.slice(0, 12)}…`);

  // Register as site banner.
  const setRes = await fetch(`${target}/admin/settings/banner`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ imageId: id })
  });
  if (!setRes.ok) throw new Error(`set banner failed: ${setRes.status} ${await setRes.text()}`);
  console.log(`==> site banner set (${id.slice(0, 12)}…)`);
  /* c8 ignore stop */
}

// ---- arg helpers ------------------------------------------------------

function numberFlag(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  if (i + 1 >= args.length) throw new Error(`${flag} requires a numeric value`);
  const v = Number(args[i + 1]);
  if (!Number.isFinite(v)) throw new Error(`${flag} requires a numeric value`);
  return v;
}

function stringFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  if (i + 1 >= args.length) throw new Error(`${flag} requires a value`);
  return args[i + 1];
}

/* c8 ignore start -- only reached from c8-ignored list/post success paths */
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
/* c8 ignore stop */
