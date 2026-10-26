// Push a WordPress post to a running rkr-blog instance via its admin
// API. Used by `site-admin import-wp push` to seed a remote site (e.g.
// the fly.io demo) without needing local FS access on the target.
//
// Flow:
//   1. fetchPost from WP REST            (lib/wp-import.fetchPost)
//   2. importPost into a temp siteRoot   (lib/wp-import.importPost)
//      → produces local markdown + originals/<id>.<ext> + sidecars
//   3. POST each original to <to>/admin/upload  (multipart, bearer)
//   4. Convert the markdown to a JSON block tree (lib/markdown-migrate)
//      and POST it to <to>/admin/blocks/:slug (JSON, bearer), which
//      indexes the page so it is publicly visible.
//   5. clean up the temp siteRoot
//
// The markdown write route (`POST /admin/posts`) was retired with the
// JSON cutover, so the blocks endpoint is the only remote write path.
//
// Authentication is a bearer token matching the target's ADMIN_TOKEN env
// var (see lib/auth-middleware.ts). The same auth bridge is what makes
// the CSRF guard ignore these requests, since they don't carry cookies.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { migratePostToTree } from './markdown-migrate.ts';
import { imageInfo } from './originals.ts';
import { safeFetch, UnsafeUrlError } from './url-safety.ts';
import { importPost } from './wp-import.ts';
import type { WpPost } from './wp-import-types.ts';
import type { WpSource } from './wp-source.ts';

export interface PushOpts {
  wpBaseUrl: string;
  slug: string | number;
  /** Target rkr-blog base URL, e.g. https://roll-along.rkroll.com */
  toUrl: string;
  /** Matches ADMIN_TOKEN env on the target. */
  token: string;
  /** Override status set on the remote post. When omitted the status is
   * derived from the WP object: `publish` → published, anything else
   * (draft, pending, private) → draft. */
  status?: 'draft' | 'published';
  /** Inject a custom fetch (tests use one against a loopback server). */
  fetcher?: typeof fetch;
  /** Override the image fetcher passed to importPost. Default uses the
   * SSRF-guarded fetch from wp-import; tests inject a plain fetch so
   * they can serve images from a loopback fixture port. */
  fetchImage?: (url: string) => Promise<Readable>;
  /** Content source. Default: the REST API at `wpBaseUrl`. Pass a
   * sqliteSource to push from a backup. */
  source?: WpSource;
}

export interface PushResult {
  slug: string;
  title: string;
  status: 'draft' | 'published';
  imagesUploaded: number;
  imagesFailed: number;
  /** True if /admin/blocks reported the page was new (false = overwrite). */
  inserted: boolean;
}

export async function pushPost(opts: PushOpts): Promise<PushResult> {
  const post = opts.source
    ? await opts.source.fetchPost(opts.slug)
    : await fetchWpPost(opts.fetcher ?? fetch, opts.wpBaseUrl, opts.slug);
  return pushWpObject(post, opts);
}

/** Push a WP *page* (e.g. roll-along's About) as the `_about` system
 * post. There is no longer a write route for it: `_about` stays a
 * markdown-only system page and the blocks endpoints reject
 * `_`-prefixed slugs. Fail loudly rather than silently skipping it. */
export async function pushPage(opts: PushOpts): Promise<PushResult> {
  throw new Error(
    `cannot push /${opts.slug} to ${opts.toUrl}: _about is a markdown-only system page ` +
      'and the blocks endpoints reject _-prefixed slugs'
  );
}

async function pushWpObject(post: WpPost, opts: PushOpts): Promise<PushResult> {
  const fetcher = opts.fetcher ?? fetch;
  const targetBase = stripTrailingSlash(opts.toUrl);
  const auth = `Bearer ${opts.token}`;
  // Without an explicit --status, a WP draft must land as a draft: the
  // backup source returns unpublished posts, and publishing one is not
  // recoverable from the operator's side.
  const status = opts.status ?? (post.status === 'publish' ? 'published' : 'draft');

  // 1. Run the local importer into a tempdir (the WP object was already
  //    fetched by the caller — pushPost via fetchWpPost, pushPage via
  //    fetchWpPage). Produces local markdown + originals + sidecars.
  const bannerUrl = post.featured_media
    ? ((opts.source
        ? await opts.source.fetchFeaturedMediaUrl(post.featured_media)
        : await fetchFeaturedMediaUrlDirect(fetcher, opts.wpBaseUrl, post.featured_media)) ??
      undefined)
    : undefined;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-wp-push-'));
  try {
    for (const sub of ['sidecars', 'originals', 'cache/img', 'data', 'content/posts']) {
      fs.mkdirSync(path.join(tmp, sub), { recursive: true });
    }
    const imageFetcher = opts.fetchImage ?? (opts.source ? opts.source.fetchImage : undefined);
    const result = await importPost(post, {
      siteRoot: tmp,
      ...(imageFetcher ? { fetchImage: imageFetcher } : {}),
      ...(opts.source ? { fetchTagNames: opts.source.fetchTagNames } : {}),
      ...(bannerUrl ? { bannerUrl } : {})
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
        const info = await imageInfo(tmp, id);
        if (!info) throw new Error(`no original on disk for ${id}`);
        await uploadOriginal({
          fetcher,
          targetBase,
          auth,
          filePath: info.path
        });
        uploaded++;
      } catch (err) {
        failed++;
        console.warn(`  ! upload ${id.slice(0, 12)}…: ${(err as Error).message}`);
      }
    }

    // 3. Convert the importer's markdown to a JSON block tree and POST
    //    it to /admin/blocks/:slug. The URL slug wins server-side; the
    //    tree still carries fields.slug/title/date/tags so the target's
    //    index can list and pair the page. `status` is forced from the
    //    WP object + --status, overriding the importer's `draft` default.
    const tree = migratePostToTree(result.markdown);
    const pageSlug = tree.fields.slug || String(post.slug);
    tree.fields.slug = pageSlug;
    tree.fields.title = tree.fields.title || post.title.rendered;
    tree.fields.status = status;
    const postRes = await fetcher(`${targetBase}/admin/blocks/${encodeURIComponent(pageSlug)}`, {
      method: 'POST',
      headers: {
        authorization: auth,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ tree })
    });
    if (!postRes.ok) {
      throw new Error(`POST /admin/blocks/${pageSlug}: ${postRes.status} ${await postRes.text()}`);
    }
    const created = (await postRes.json()) as { slug: string; inserted?: boolean };

    // The save route indexes the page it writes, so the pushed page is
    // public without a reindex.

    return {
      slug: created.slug,
      title: tree.fields.title,
      status,
      imagesUploaded: uploaded,
      imagesFailed: failed,
      inserted: created.inserted ?? false
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

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** No-source fallback kept for direct API callers and tests: uses
 * safeFetch per-hop validation; localhost is allowed for loopback test
 * fixtures (otherwise safeFetch would reject private IP). CLI pushes
 * never reach it — resolveSource always supplies a source, so they go
 * through wp-rest.fetchPost and its guard. */
async function fetchWpPost(
  fetcher: typeof fetch,
  baseUrl: string,
  idOrSlug: string | number
): Promise<WpPost> {
  const base = stripTrailingSlash(baseUrl);
  const fields = '_fields=id,date,modified,slug,status,title,content,excerpt,link,featured_media';
  const doFetch = async (url: string): Promise<Response> => {
    const isLocalhost = /localhost|127\.0\.0\.1/.test(baseUrl);
    if (isLocalhost) return fetcher(url);
    try {
      return await safeFetch(url, { fetcher });
    } catch (err) {
      if (err instanceof UnsafeUrlError) throw new Error(`unsafe url: ${err.message}`);
      throw err;
    }
  };
  if (typeof idOrSlug === 'number' || /^\d+$/.test(String(idOrSlug))) {
    const url = `${base}/wp-json/wp/v2/posts/${idOrSlug}?${fields}`;
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`WP fetch: ${res.status} ${url}`);
    return (await res.json()) as WpPost;
  }
  const url = `${base}/wp-json/wp/v2/posts?slug=${encodeURIComponent(String(idOrSlug))}&${fields}`;
  const res = await doFetch(url);
  if (!res.ok) throw new Error(`WP fetch: ${res.status} ${url}`);
  const arr = (await res.json()) as WpPost[];
  if (arr.length === 0) throw new Error(`no post with slug "${idOrSlug}"`);
  return arr[0] as WpPost;
}

/** No-source fallback for direct API callers and tests: fetch the source
 * URL of a WP featured media item, via safeFetch per-hop (localhost
 * allowed for fixtures). CLI pushes use the source's
 * fetchFeaturedMediaUrl instead. */
async function fetchFeaturedMediaUrlDirect(
  fetcher: typeof fetch,
  baseUrl: string,
  mediaId: number
): Promise<string | null> {
  if (!mediaId) return null;
  const url = `${stripTrailingSlash(baseUrl)}/wp-json/wp/v2/media/${mediaId}?_fields=source_url`;
  const isLocalhost = /localhost|127\.0\.0\.1/.test(baseUrl);
  const raw: Response | null = isLocalhost
    ? await fetcher(url)
    : await (async (): Promise<Response | null> => {
        try {
          return await safeFetch(url, { fetcher });
        } catch (err) {
          if (err instanceof UnsafeUrlError) return null;
          throw err;
        }
      })();
  if (!raw?.ok) return null;
  const res = raw as Response;
  const data = (await res.json()) as { source_url?: string };
  return data.source_url ?? null;
}
