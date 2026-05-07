// Push a WordPress post to a running rkroll-cms instance via its admin
// API. Used by `site-admin import-wp push` to seed a remote site (e.g.
// the fly.io demo) without needing local FS access on the target.
//
// Flow:
//   1. fetchPost from WP REST            (lib/wp-import.fetchPost)
//   2. importPost into a temp siteRoot   (lib/wp-import.importPost)
//      → produces local markdown + originals/<id>.<ext> + sidecars
//   3. POST each original to <to>/admin/upload  (multipart, bearer)
//   4. POST the markdown body to <to>/admin/posts (JSON, bearer)
//   5. clean up the temp siteRoot
//
// Authentication is a bearer token matching the target's ADMIN_TOKEN env
// var (see lib/auth-middleware.ts). The same auth bridge is what makes
// the CSRF guard ignore these requests, since they don't carry cookies.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { FORMAT_TO_EXT, originalPath } from './originals.ts';
import { read as sidecarRead } from './sidecar.ts';
import { importPost, type WpPost } from './wp-import.ts';

export interface PushOpts {
  wpBaseUrl: string;
  slug: string | number;
  /** Target rkroll-cms base URL, e.g. https://rkr-blog.fly.dev */
  toUrl: string;
  /** Matches ADMIN_TOKEN env on the target. */
  token: string;
  /** Override status set on the remote post. Default: published (so the
   * post is visible on /). The local importer always emits draft. */
  status?: 'draft' | 'published';
  /** Inject a custom fetch (tests use one against a loopback server). */
  fetcher?: typeof fetch;
  /** Override the image fetcher passed to importPost. Default uses the
   * SSRF-guarded fetch from wp-import; tests inject a plain fetch so
   * they can serve images from a loopback fixture port. */
  fetchImage?: (url: string) => Promise<Readable>;
}

export interface PushResult {
  slug: string;
  title: string;
  status: 'draft' | 'published';
  imagesUploaded: number;
  imagesFailed: number;
  /** True if /admin/posts reported the post was new (false = overwrite). */
  inserted: boolean;
}

export async function pushPost(opts: PushOpts): Promise<PushResult> {
  const fetcher = opts.fetcher ?? fetch;
  const targetBase = stripTrailingSlash(opts.toUrl);
  const auth = `Bearer ${opts.token}`;
  const status = opts.status ?? 'published';

  // 1. Pull from WP, run the local importer into a tempdir.
  //    We don't go through wp-import.fetchPost here because that uses
  //    safeFetch, which rejects non-default ports / private IPs — both
  //    are common in tests and in operator-driven invocations against
  //    a self-hosted WP. SSRF defense matters when an attacker chose
  //    the URL; the push CLI is the operator typing it themselves.
  const post = await fetchWpPost(fetcher, opts.wpBaseUrl, opts.slug);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-wp-push-'));
  try {
    for (const sub of ['sidecars', 'originals', 'cache/img', 'data', 'content/posts']) {
      fs.mkdirSync(path.join(tmp, sub), { recursive: true });
    }
    const result = await importPost(post, {
      siteRoot: tmp,
      ...(opts.fetchImage ? { fetchImage: opts.fetchImage } : {})
    });

    // 2. Upload each ingested original. Originals are sharded on disk
    //    (originals/<id[0:2]>/<id[2:4]>/<id>.<ext>) so we walk the ids
    //    importPost reported, look up each one's ext via the sidecar,
    //    and POST the bytes. The remote re-derives the same sha256 id
    //    from the upload, so directives in the markdown still resolve.
    //    De-duplicate ids — a gallery of identical bytes ingests once
    //    but the importer reports the same id once per source figure.
    const uniqueIds = Array.from(new Set(result.imagesIngested));
    let uploaded = 0;
    let failed = 0;
    for (const id of uniqueIds) {
      try {
        const sidecar = await sidecarRead(tmp, id);
        const format = sidecar?.metadata.format;
        const ext = format ? FORMAT_TO_EXT[format] : undefined;
        if (!ext) throw new Error(`no ext resolved for ${id} (format=${format ?? 'none'})`);
        await uploadOriginal({
          fetcher,
          targetBase,
          auth,
          filePath: originalPath(tmp, id, ext)
        });
        uploaded++;
      } catch (err) {
        failed++;
        console.warn(`  ! upload ${id.slice(0, 12)}…: ${(err as Error).message}`);
      }
    }

    // 3. POST the markdown body to /admin/posts. The importer's emitted
    //    file has YAML frontmatter; the endpoint wants the title/slug/
    //    status/date as fields and the markdown body separate. Split.
    const { frontmatter, body } = splitFrontmatter(result.markdown);
    const postRes = await fetcher(`${targetBase}/admin/posts`, {
      method: 'POST',
      headers: {
        authorization: auth,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        slug: frontmatter.slug ?? post.slug,
        title: frontmatter.title ?? post.title.rendered,
        status,
        date: frontmatter.date ?? post.date,
        markdown: body
      })
    });
    if (!postRes.ok) {
      throw new Error(`POST /admin/posts: ${postRes.status} ${await postRes.text()}`);
    }
    const created = (await postRes.json()) as { slug: string; inserted: boolean };

    return {
      slug: created.slug,
      title: frontmatter.title ?? post.title.rendered,
      status,
      imagesUploaded: uploaded,
      imagesFailed: failed,
      inserted: created.inserted
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

interface UploadArgs {
  fetcher: typeof fetch;
  targetBase: string;
  auth: string;
  filePath: string;
}

async function uploadOriginal(args: UploadArgs): Promise<void> {
  const buf = fs.readFileSync(args.filePath);
  const filename = path.basename(args.filePath);
  // FormData + Blob are global in Node 22. The /admin/upload endpoint
  // is multipart and returns { id } — we don't need to verify the id
  // because both sides derive it from the same bytes via sha256.
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(buf)]), filename);
  const res = await args.fetcher(`${args.targetBase}/admin/upload`, {
    method: 'POST',
    headers: { authorization: args.auth },
    body: fd
  });
  if (!res.ok) {
    throw new Error(`POST /admin/upload: ${res.status} ${await res.text()}`);
  }
}

interface SplitMarkdown {
  frontmatter: Record<string, string>;
  body: string;
}

/** Cheap splitter: peels the leading `---\n...\n---` block off, parses
 * its `key: value` lines into a record, and returns the body. The
 * importer's frontmatter is always well-formed (we wrote it), so a
 * full YAML parse isn't necessary. */
function splitFrontmatter(raw: string): SplitMarkdown {
  const m = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  const fm: Record<string, string> = {};
  const fmText = m[1] ?? '';
  for (const line of fmText.split('\n')) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = (kv[2] ?? '').trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (kv[1]) fm[kv[1]] = value;
  }
  return { frontmatter: fm, body: m[2] ?? '' };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Plain WP REST fetch — same shape as wp-import.fetchPost but without
 * the safeFetch SSRF guard (the operator picked the URL). */
async function fetchWpPost(
  fetcher: typeof fetch,
  baseUrl: string,
  idOrSlug: string | number
): Promise<WpPost> {
  const base = stripTrailingSlash(baseUrl);
  if (typeof idOrSlug === 'number' || /^\d+$/.test(String(idOrSlug))) {
    const url = `${base}/wp-json/wp/v2/posts/${idOrSlug}`;
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`WP fetch: ${res.status} ${url}`);
    return (await res.json()) as WpPost;
  }
  const url = `${base}/wp-json/wp/v2/posts?slug=${encodeURIComponent(String(idOrSlug))}`;
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`WP fetch: ${res.status} ${url}`);
  const arr = (await res.json()) as WpPost[];
  if (arr.length === 0) throw new Error(`no post with slug "${idOrSlug}"`);
  return arr[0] as WpPost;
}
