// WordPress REST API client. listPosts / fetchPost wrap the
// /wp-json/wp/v2/posts endpoints so the CLI (`import-wp list` /
// `import-wp post`) and tests can drive them without coupling to the
// importPost pipeline. Production wiring goes through safeFetch
// (SSRF-guarded); tests inject a plain fetch against a loopback
// fixture server.

import { safeFetch } from './url-safety.ts';
import type { WpPost } from './wp-import-types.ts';

export interface ListResult {
  posts: WpPost[];
  total: number;
  totalPages: number;
}

/** Fetcher signature used by listPosts / fetchPost. */
export type WpFetcher = (url: string, init?: RequestInit) => Promise<Response>;

/* c8 ignore next 4 -- thin wrapper; tests inject the fetcher directly */
const defaultWpFetcher: WpFetcher = (url) =>
  safeFetch(url, { timeoutMs: 30_000 }) as unknown as Promise<Response>;

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/** Fetch one page of posts. Adds `_fields` so we don't transfer
 * unused columns (saves ~20% on the wire). */
export async function listPosts(
  baseUrl: string,
  opts: { page?: number; perPage?: number; status?: string } = {},
  fetcher: WpFetcher = defaultWpFetcher
): Promise<ListResult> {
  const page = opts.page ?? 1;
  const perPage = Math.min(100, Math.max(1, opts.perPage ?? 50));
  const status = opts.status ?? 'publish';
  const fields = [
    'id',
    'date',
    'modified',
    'slug',
    'status',
    'title',
    'excerpt',
    'link',
    'categories',
    'tags'
  ].join(',');
  const url = `${stripTrailingSlash(baseUrl)}/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&status=${status}&_fields=${fields}`;
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`WP listPosts: ${res.status} ${url}`);
  const total = Number(res.headers.get('X-WP-Total') ?? 0);
  const totalPages = Number(res.headers.get('X-WP-TotalPages') ?? 0);
  const posts = (await res.json()) as WpPost[];
  return { posts, total, totalPages };
}

/** Fetch a single post by numeric id or slug. */
export async function fetchPost(
  baseUrl: string,
  idOrSlug: string | number,
  fetcher: WpFetcher = defaultWpFetcher
): Promise<WpPost> {
  const base = stripTrailingSlash(baseUrl);
  if (typeof idOrSlug === 'number' || /^\d+$/.test(idOrSlug)) {
    const url = `${base}/wp-json/wp/v2/posts/${idOrSlug}`;
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`WP fetchPost: ${res.status} ${url}`);
    return (await res.json()) as WpPost;
  }
  // Slug lookup: ?slug=foo returns an array of posts whose slug matches.
  const url = `${base}/wp-json/wp/v2/posts?slug=${encodeURIComponent(idOrSlug)}`;
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`WP fetchPost: ${res.status} ${url}`);
  const arr = (await res.json()) as WpPost[];
  if (arr.length === 0) throw new Error(`WP fetchPost: no post with slug "${idOrSlug}"`);
  return arr[0] as WpPost;
}
