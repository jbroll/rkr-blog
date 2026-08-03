// Where WP content comes from. `restSource` reads a live install over
// its REST API (lib/wp-rest.ts); `sqliteSource` (lib/wp-sqlite.ts)
// reads a converted database dump plus the uploads tree. The CLI picks
// one and the rest of the import pipeline is unaware of the difference.

import type { Readable } from 'node:stream';

import { defaultImageFetcher, defaultTagFetcher } from './wp-import.ts';
import type {
  CommentListResult,
  ListResult,
  WpFetcher,
  WpPost,
  WpSiteInfo
} from './wp-import-types.ts';
import {
  fetchFeaturedMediaUrl,
  fetchPost,
  fetchWpPage,
  fetchWpSiteBannerUrl,
  fetchWpSiteInfo,
  listComments,
  listPosts
} from './wp-rest.ts';

export interface ListPostsOpts {
  page?: number;
  perPage?: number;
  /** WP status: `publish`, `draft`, or `any`. */
  status?: string;
}

export interface ListCommentsOpts {
  page?: number;
  perPage?: number;
}

export interface WpSource {
  listPosts(opts?: ListPostsOpts): Promise<ListResult>;
  fetchPost(idOrSlug: string | number): Promise<WpPost>;
  fetchPage(slug: string): Promise<WpPost>;
  fetchSiteInfo(): Promise<WpSiteInfo>;
  fetchSiteBannerUrl(): Promise<string | null>;
  fetchFeaturedMediaUrl(mediaId: number): Promise<string | null>;
  listComments(opts?: ListCommentsOpts): Promise<CommentListResult>;
  /** Passed to importPost as `opts.fetchImage`. */
  fetchImage(url: string): Promise<Readable>;
  /** Passed to importPost as `opts.fetchTagNames`. */
  fetchTagNames(tagIds: number[], postLink: string): Promise<string[]>;
  /** Release resources (a database handle for the SQLite source; a
   * no-op for REST). */
  close(): void;
}

/** WP content over the REST API of a live install. */
export function restSource(baseUrl: string, fetcher?: WpFetcher): WpSource {
  const args = fetcher ? ([fetcher] as const) : ([] as const);
  const image = defaultImageFetcher();
  const tags = defaultTagFetcher();
  return {
    listPosts: (opts = {}) => listPosts(baseUrl, opts, ...args),
    fetchPost: (idOrSlug) => fetchPost(baseUrl, idOrSlug, ...args),
    fetchPage: (slug) => fetchWpPage(baseUrl, slug, ...args),
    fetchSiteInfo: () => fetchWpSiteInfo(baseUrl, ...args),
    fetchSiteBannerUrl: () => fetchWpSiteBannerUrl(baseUrl, ...args),
    fetchFeaturedMediaUrl: (mediaId) => fetchFeaturedMediaUrl(baseUrl, mediaId, ...args),
    listComments: (opts = {}) => listComments(baseUrl, opts, ...args),
    fetchImage: (url) => image(url),
    fetchTagNames: (tagIds, postLink) => tags(tagIds, postLink),
    close: () => {}
  };
}
