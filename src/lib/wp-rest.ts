// WordPress REST API client. listPosts / fetchPost wrap the
// /wp-json/wp/v2/posts endpoints so the CLI (`import-wp list` /
// `import-wp post`) and tests can drive them without coupling to the
// importPost pipeline. Production wiring goes through safeFetch
// (SSRF-guarded); tests inject a plain fetch against a loopback
// fixture server.

import { safeFetch } from './url-safety.ts';
import type { WpComment, WpPost } from './wp-import-types.ts';

export interface ListResult {
  posts: WpPost[];
  total: number;
  totalPages: number;
}

export interface CommentListResult {
  comments: WpComment[];
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
    'tags',
    'featured_media'
  ].join(',');
  const url = `${stripTrailingSlash(baseUrl)}/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&status=${status}&_fields=${fields}`;
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`WP listPosts: ${res.status} ${url}`);
  const total = Number(res.headers.get('X-WP-Total') ?? 0);
  const totalPages = Number(res.headers.get('X-WP-TotalPages') ?? 0);
  const posts = (await res.json()) as WpPost[];
  return { posts, total, totalPages };
}

/** Fetch the site-wide banner/header image URL from a WP home page.
 * Looks for an <img> whose src contains "cropped-" — the WP convention
 * for custom header images. Returns null if none is found. */
export async function fetchWpSiteBannerUrl(
  baseUrl: string,
  fetcher: WpFetcher = defaultWpFetcher
): Promise<string | null> {
  const url = stripTrailingSlash(baseUrl) + '/';
  const res = await fetcher(url);
  if (!res.ok) return null;
  const html = await res.text();
  // WP custom header images always have "cropped-" in their filename.
  const m = /src="([^"]*cropped-[^"]*)"/.exec(html);
  return m?.[1] ?? null;
}

export interface WpSiteInfo {
  name: string;
  description: string;
}

/** Fetch site title and tagline from the WP REST API root (`/wp-json/`). */
export async function fetchWpSiteInfo(
  baseUrl: string,
  fetcher: WpFetcher = defaultWpFetcher
): Promise<WpSiteInfo> {
  const url = `${stripTrailingSlash(baseUrl)}/wp-json/`;
  const res = await fetcher(url);
  if (!res.ok) return { name: '', description: '' };
  const data = (await res.json()) as Record<string, unknown>;
  return {
    name: typeof data.name === 'string' ? data.name : '',
    description: typeof data.description === 'string' ? data.description : ''
  };
}

/** Fetch the source URL of a WP featured media item.
 * Returns null if the media ID is 0 (WP's sentinel for "no featured image"). */
export async function fetchFeaturedMediaUrl(
  baseUrl: string,
  mediaId: number,
  fetcher: WpFetcher = defaultWpFetcher
): Promise<string | null> {
  if (!mediaId) return null;
  const url = `${stripTrailingSlash(baseUrl)}/wp-json/wp/v2/media/${mediaId}?_fields=source_url`;
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`WP fetchFeaturedMediaUrl: ${res.status} ${url}`);
  const data = (await res.json()) as { source_url?: string };
  return data.source_url ?? null;
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

/** Fetch one page of approved comments (public endpoint returns only
 * approved). `_fields` trims the payload. */
export async function listComments(
  baseUrl: string,
  opts: { page?: number; perPage?: number } = {},
  fetcher: WpFetcher = defaultWpFetcher
): Promise<CommentListResult> {
  const page = opts.page ?? 1;
  const perPage = Math.min(100, Math.max(1, opts.perPage ?? 100));
  const fields = ['id', 'post', 'parent', 'author_name', 'author_url', 'date', 'content'].join(',');
  const url = `${stripTrailingSlash(baseUrl)}/wp-json/wp/v2/comments?per_page=${perPage}&page=${page}&_fields=${fields}`;
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`WP listComments: ${res.status} ${url}`);
  const total = Number(res.headers.get('X-WP-Total') ?? 0) || 0;
  const totalPages = Number(res.headers.get('X-WP-TotalPages') ?? 0) || 0;
  const comments = (await res.json()) as WpComment[];
  return { comments, total, totalPages };
}
