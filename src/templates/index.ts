// Index page template. Doubles as the admin posts list when the
// visitor is authed (drafts join published, per-row edit affordances
// appear). Anonymous view stays the plain reverse-chrono list of
// published titles.
//
// Combining the two pages means an admin lands directly on a fully-
// editable list — no separate "Posts" tab to discover, the homepage
// IS the dashboard. Edits go through the JSON blocks editor.

import { escapeAttr, escapeText } from '../lib/content.ts';
import { icon } from './icons.ts';
import {
  bundleVersion,
  headIcons,
  indexAdminFabs,
  renderSearchForm,
  type SiteChrome,
  siteFoot,
  siteHead,
  stylesheetLinks
} from './layout.ts';
import { buildMetaTag } from './version-tag.ts';

interface IndexEntry {
  slug: string;
  title: string;
  date?: string;
  /** Admin view only. Anonymous lists already filter to published. */
  status?: 'draft' | 'published';
  /** Admin view only. ISO timestamp for the Updated column. */
  updatedAt?: string;
}

export interface IndexTeaser {
  slug: string;
  title: string;
  date?: string;
  /** Trusted renderer output (figure widget HTML). */
  bannerHtml: string;
  /** Trusted renderer output (first paragraph → inline HTML). */
  excerptHtml: string;
}

export interface IndexPageData extends SiteChrome {
  posts: IndexEntry[];
  page: number;
  totalPages: number;
  /** Full-bleed site banner rendered between site header and <main>.
   * Populated when the site config has a bannerImageId. */
  bannerHtml?: string;
  /** When true, bannerHtml renders above the site header instead of
   * between the header and <main>. */
  bannerAboveHeader?: boolean;
  /** Anonymous view only. When set, the top post is featured above the
   * list and is expected to have been removed from `posts` by the route. */
  teaser?: IndexTeaser;
  /** Logged-in admin → render the admin strip in siteHead and the
   * full posts table (drafts + edit links). */
  isAdmin?: boolean;
  /** Tag counts for the tag rail sidebar. When absent or empty, the
   * rail is not rendered. */
  tagCounts?: { name: string; count: number }[];
  /** The currently-active tag filter. At most one element — clicking another
   * tag replaces the selection (OR/replace, not AND). */
  activeTags?: string[];
  /** Current sort direction. 'desc' (default) = newest first; 'asc' = oldest first. */
  sort?: 'asc' | 'desc';
  /** The path this index is served at; tag, sort and pager links keep to
   * it. '/posts' when a home page takes over '/'. Default '/'. */
  basePath?: '/' | '/posts';
}

export function renderIndexPage(data: IndexPageData): string {
  const a = data.assets;
  const v = bundleVersion(a);
  const body = data.isAdmin ? renderAdminTable(data.posts) : renderAnonymousList(data.posts);
  const teaserHtml = !data.isAdmin && data.teaser ? renderTeaser(data.teaser) : '';
  const blocksLink = data.isAdmin
    ? `<p class="rkr-admin-blocks-link"><a href="/admin/blocks">Blocks pages →</a> <span>JSON pages in the new editor</span></p>\n`
    : '';
  const isAsc = data.sort === 'asc';
  const activeTags = data.activeTags ?? [];
  // Build query suffix for pager — preserves all active tags + sort together.
  const tagSuffix = activeTags.length
    ? `&amp;${activeTags.map((t) => `tag=${encodeURIComponent(t)}`).join('&amp;')}`
    : '';
  const sortSuffix = isAsc ? '&amp;sort=asc' : '';
  const basePath = data.basePath ?? '/';
  const pager =
    data.totalPages > 1
      ? `<nav aria-label="pagination">
  <span>page ${data.page} of ${data.totalPages}</span>
  ${data.page > 1 ? `<a rel="prev" href="${basePath}?page=${data.page - 1}${tagSuffix}${sortSuffix}">prev</a>` : ''}
  ${data.page < data.totalPages ? `<a rel="next" href="${basePath}?page=${data.page + 1}${tagSuffix}${sortSuffix}">next</a>` : ''}
</nav>`
      : '';
  const sortToggle = renderSortToggle(basePath, isAsc, activeTags);
  const tagRail = renderTagRail(
    basePath,
    data.tagCounts,
    activeTags,
    `${sortToggle}${renderSearchForm()}`
  );
  const head = siteHead(data.site, {
    assets: a,
    isAdmin: data.isAdmin,
    hideHomeLink: basePath === '/',
    buildHash: a.hash,
    ...(data.chrome ? { chrome: data.chrome } : {})
  });
  const banner = data.bannerHtml ?? '';
  const siteChrome = data.bannerAboveHeader ? `${banner}${head}` : `${head}\n${banner}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeText(data.site.title)}</title>
${stylesheetLinks(a)}
${headIcons(a)}
${buildMetaTag(a.hash)}
<meta name="theme-color" content="#1a4f7f"/>
<script type="module" src="${a.base}/site/sw-unregister.js${v}" defer></script>
<script type="module" src="${a.base}/site/version-check.js${v}" defer></script>
<script type="module" src="${a.base}/site/version-check.js${v}" defer></script>
</head>
<body>
${siteChrome}<main id="main" tabindex="-1">
<div class="rkr-index-layout rkr-index-layout--has-rail">
<div class="rkr-index-posts">
<h1 class="rkr-index-heading">${escapeText(data.site.title)}</h1>
${teaserHtml}${blocksLink}${body}
${pager}
</div>
${tagRail}
</div>
</main>
${siteFoot(data.site, { isAdmin: data.isAdmin })}
${data.isAdmin ? indexAdminFabs() : ''}
</body>
</html>
`;
}

function renderAnonymousList(posts: IndexEntry[]): string {
  const dayCounts = countByDay(posts, (p) => p.date);
  const items = posts
    .map((p) => {
      const dateBlock = p.date
        ? `<time datetime="${escapeAttr(p.date)}">${escapeText(formatListDate(p.date, dayCounts.get(p.date.slice(0, 10)) ?? 0))}</time>`
        : /* c8 ignore next -- runReindex always supplies published_at on listed posts */ '';
      return `  <li><a href="/${escapeAttr(p.slug)}">${escapeText(p.title)}</a>${dateBlock}</li>`;
    })
    .join('\n');
  return `<ul class="post-list">
${items}
</ul>`;
}

function renderTeaser(t: IndexTeaser): string {
  const dateBlock = t.date
    ? `<time datetime="${escapeAttr(t.date)}">${escapeText(t.date.slice(0, 10))}</time>`
    : '';
  return `<article class="rkr-teaser">
${t.bannerHtml}<div class="rkr-teaser-body">
<h2 class="rkr-teaser-title"><a href="/${escapeAttr(t.slug)}">${escapeText(t.title)}</a></h2>
${dateBlock}
<div class="rkr-teaser-excerpt">${t.excerptHtml}</div>
<a class="rkr-teaser-more" href="/${escapeAttr(t.slug)}">Read the full post &rarr;</a>
</div>
</article>
`;
}

/** Group an ISO-string field across the list, returning per-day
 * counts keyed on YYYY-MM-DD. Used to decide whether to append a
 * HH:MM disambiguator to a post's date label. */
function countByDay(
  posts: IndexEntry[],
  pick: (p: IndexEntry) => string | undefined
): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of posts) {
    const iso = pick(p);
    if (!iso) continue;
    const day = iso.slice(0, 10);
    out.set(day, (out.get(day) ?? 0) + 1);
  }
  return out;
}

/** "YYYY-MM-DD" when this is the only post on the day; "YYYY-MM-DD
 * HH:MM" when another post shares the day (UTC, 24h). The time
 * is only present to disambiguate — wall-clock dates without
 * minutes are the common case and read cleanly. */
function formatListDate(iso: string, sameDayCount: number): string {
  const day = iso.slice(0, 10);
  if (sameDayCount <= 1) return day;
  const time = iso.slice(11, 16);
  return time ? `${day} ${time}` : day;
}

function renderAdminTable(posts: IndexEntry[]): string {
  // The table is wider than the viewport on a phone. Wrap it in a
  // .rkr-admin-posts-scroll container so the overflow scrolls inside
  // the wrapper instead of expanding the body — when the body widens
  // past the viewport, iOS Safari anchors `position: fixed` elements
  // (the FAB stack) to the body's right edge, shoving them off-
  // screen. Keeping the body viewport-width keeps the FABs visible.
  if (posts.length === 0) {
    return `<div class="rkr-admin-posts-scroll"><table class="rkr-admin-posts">
  <tbody>
    <tr><td colspan="3" class="rkr-admin-posts-empty">No posts yet. <a href="/admin/blocks/new">Create one</a>.</td></tr>
  </tbody>
</table></div>`;
  }
  const dayCounts = countByDay(posts, (p) => p.date ?? p.updatedAt);
  // No <thead>: title + date + icon control speak for themselves;
  // a header row of "Title / Updated / Edit" is visual noise. Each
  // control's aria-label carries the accessible name for screen readers.
  return `<div class="rkr-admin-posts-scroll"><table class="rkr-admin-posts">
  <tbody>
${posts.map((p) => renderAdminRow(p, dayCounts)).join('\n')}
  </tbody>
</table></div>`;
}

function renderAdminRow(p: IndexEntry, dayCounts: Map<string, number>): string {
  const iso = p.date ?? p.updatedAt ?? '';
  const label = iso ? formatListDate(iso, dayCounts.get(iso.slice(0, 10)) ?? 0) : '';
  const slugUri = encodeURIComponent(p.slug);
  return `  <tr data-slug="${escapeAttr(p.slug)}">
    <td><a href="/${escapeAttr(p.slug)}">${escapeText(p.title)}</a></td>
    <td>${iso ? `<time datetime="${escapeAttr(iso)}">${escapeText(label)}</time>` : ''}</td>
    <td class="rkr-admin-posts-action">
      <a class="rkr-admin-posts-edit" href="/admin/blocks/edit/${slugUri}" aria-label="Edit ${escapeAttr(p.title)}" title="Edit">${icon('pencil', 18)}</a>
    </td>
  </tr>`;
}

/** Renders the tag rail aside. Returns empty string when tagCounts is
 * absent or empty — callers can splice the result directly into the
 * HTML without a wrapper conditional. */
/** The posts-list rail: sort + search controls on top, tag pills
 * below. Always rendered on the index so the controls are present
 * even with no tags / on the admin view. `controls` is trusted HTML
 * (sort toggle + search form). */
function renderTagRail(
  basePath: string,
  tagCounts: { name: string; count: number }[] | undefined,
  activeTags: string[],
  controls: string
): string {
  const pills =
    tagCounts && tagCounts.length > 0
      ? `\n<nav class="rkr-tag-pills" aria-label="Tags">\n${tagCounts
          .map((t) => {
            const isActive = activeTags.includes(t.name);
            // OR/replace: clicking the active tag clears the filter;
            // clicking any other tag switches to it exclusively.
            const href = isActive ? basePath : `${basePath}?tag=${encodeURIComponent(t.name)}`;
            const current = isActive ? ' aria-current="page"' : '';
            return `  <a class="rkr-tag-pill" href="${escapeAttr(href)}"${current}>${escapeText(t.name)} (${t.count})</a>`;
          })
          .join('\n')}\n</nav>`
      : '';
  return `<aside class="rkr-tag-rail">
<div class="rkr-rail-controls">${controls}</div>${pills}
</aside>`;
}

/** Sort toggle: a link that adds/removes ?sort=asc via server-side
 * requery, for admins and visitors alike. */
function renderSortToggle(basePath: string, isAsc: boolean, activeTags: string[]): string {
  const sortIcon = icon('arrowUpDown', 14);
  const tagQS = activeTags.length
    ? activeTags.map((t) => `tag=${encodeURIComponent(t)}`).join('&amp;')
    : '';
  if (isAsc) {
    const href = tagQS ? `${basePath}?${tagQS}` : basePath;
    return `<a class="rkr-sort-toggle" href="${escapeAttr(href)}" title="Newest first" aria-label="Newest first">${sortIcon}</a>\n`;
  }
  const prefix = tagQS ? `${tagQS}&amp;` : '';
  return `<a class="rkr-sort-toggle" href="${basePath}?${prefix}sort=asc" title="Oldest first" aria-label="Oldest first">${sortIcon}</a>\n`;
}
