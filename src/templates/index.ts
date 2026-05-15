// Index page template. Doubles as the admin posts list when the
// visitor is authed (drafts join published, per-row status / pin /
// delete affordances appear). Anonymous view stays the plain
// reverse-chrono list of published titles.
//
// Combining the two pages means an admin lands directly on a fully-
// editable list — no separate "Posts" tab to discover, the homepage
// IS the dashboard.

import { escapeAttr, escapeText } from '../lib/content.ts';
import { icon } from './icons.ts';
import {
  bundleVersion,
  indexAdminFabs,
  type SiteChrome,
  siteFoot,
  siteHead,
  stylesheetLinks
} from './layout.ts';

interface IndexEntry {
  slug: string;
  title: string;
  date?: string;
  /** Admin view only. Anonymous lists already filter to published. */
  status?: 'draft' | 'published';
  /** Admin view only. ISO timestamp for the Updated column. */
  updatedAt?: string;
}

export interface IndexPageData extends SiteChrome {
  posts: IndexEntry[];
  page: number;
  totalPages: number;
  /** Full-bleed site banner rendered between site header and <main>.
   * Populated when the site config has a bannerImageId. */
  bannerHtml?: string;
  /** Logged-in admin → render the admin strip in siteHead and the
   * full posts table (drafts + status / pin / delete). */
  isAdmin?: boolean;
  /** Tag counts for the tag rail sidebar. When absent or empty, the
   * rail is not rendered. */
  tagCounts?: { name: string; count: number }[];
  /** The currently-active tag filter, if any. */
  activeTag?: string;
  /** Current sort direction. 'desc' (default) = newest first; 'asc' = oldest first. */
  sort?: 'asc' | 'desc';
}

export function renderIndexPage(data: IndexPageData): string {
  const v = bundleVersion();
  const body = data.isAdmin ? renderAdminTable(data.posts) : renderAnonymousList(data.posts);
  const isAsc = data.sort === 'asc';
  // Build query suffix for pager and sort toggle — preserves active tag + sort together.
  const tagSuffix = data.activeTag ? `&amp;tag=${encodeURIComponent(data.activeTag)}` : '';
  const sortSuffix = isAsc ? '&amp;sort=asc' : '';
  const pager =
    data.totalPages > 1
      ? `<nav aria-label="pagination">
  <span>page ${data.page} of ${data.totalPages}</span>
  ${data.page > 1 ? `<a rel="prev" href="/?page=${data.page - 1}${tagSuffix}${sortSuffix}">prev</a>` : ''}
  ${data.page < data.totalPages ? `<a rel="next" href="/?page=${data.page + 1}${tagSuffix}${sortSuffix}">next</a>` : ''}
</nav>`
      : '';
  const sortToggle = renderSortToggle(isAsc, data.activeTag, data.isAdmin);
  const tagRail = renderTagRail(data.tagCounts, data.activeTag);
  // The posts-list bundle wires status-select auto-submit + pin/unpin
  // OPFS lookups. Only emit it for the admin view — anonymous visitors
  // never see those controls.
  const postsListScript = data.isAdmin
    ? `<script type="module" src="/static/admin/posts-list.js${bundleVersion()}"></script>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeText(data.site.title)}</title>
${stylesheetLinks()}
<link rel="manifest" href="/static/manifest.webmanifest"/>
<meta name="theme-color" content="#1a4f7f"/>
<script type="module" src="/static/site/sw-register.js${v}" defer></script>
</head>
<body>
${siteHead(data.site, { isAdmin: data.isAdmin })}
${data.bannerHtml ?? ''}<main id="main" tabindex="-1">
<div class="rkr-index-layout${tagRail ? ' rkr-index-layout--has-rail' : ''}">
<div class="rkr-index-posts">
<h1 class="rkr-index-heading">${escapeText(data.site.title)}</h1>
${sortToggle}${body}
${pager}
</div>
${tagRail}
</div>
</main>
${siteFoot(data.site, { isAdmin: data.isAdmin })}
${data.isAdmin ? indexAdminFabs() : ''}
${postsListScript}
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
      return `  <li>${dateBlock}<a href="/${escapeAttr(p.slug)}">${escapeText(p.title)}</a></li>`;
    })
    .join('\n');
  return `<ul class="post-list">
${items}
</ul>`;
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
    <tr><td colspan="5" class="rkr-admin-posts-empty">No posts yet. <a href="/admin/editor">Create one</a>.</td></tr>
  </tbody>
</table></div>`;
  }
  const dayCounts = countByDay(posts, (p) => p.updatedAt ?? p.date);
  // No <thead>: title + date + icon controls speak for themselves;
  // a header row of "Title / Updated / Status / Pin / Delete" is
  // visual noise. Each control's aria-label carries the equivalent
  // accessible name for screen readers.
  return `<div class="rkr-admin-posts-scroll"><table class="rkr-admin-posts">
  <tbody>
${posts.map((p) => renderAdminRow(p, dayCounts)).join('\n')}
  </tbody>
</table></div>`;
}

function renderAdminRow(p: IndexEntry, dayCounts: Map<string, number>): string {
  const iso = p.updatedAt ?? p.date ?? '';
  const label = iso ? formatListDate(iso, dayCounts.get(iso.slice(0, 10)) ?? 0) : '';
  const slugUri = encodeURIComponent(p.slug);
  const status = p.status ?? 'draft';
  return `  <tr data-slug="${escapeAttr(p.slug)}">
    <td><a href="/${escapeAttr(p.slug)}">${escapeText(p.title)}</a></td>
    <td>${iso ? `<time datetime="${escapeAttr(iso)}">${escapeText(label)}</time>` : ''}</td>
    <td class="rkr-admin-posts-action">
      <form method="post" action="/admin/posts/${slugUri}/status" class="rkr-admin-posts-status-form">
        <input type="hidden" name="status" value="${status === 'published' ? 'draft' : 'published'}"/>
        <button type="submit" class="rkr-admin-posts-status-btn is-${status}"
          aria-label="${status === 'published' ? 'Published — click to unpublish' : 'Draft — click to publish'}"
          title="${status === 'published' ? 'Published' : 'Draft'}">${icon(status === 'published' ? 'globe' : 'lock', 18)}</button>
      </form>
    </td>
    <td class="rkr-admin-posts-action">
      <button type="button" class="rkr-admin-posts-pin" data-pin-toggle aria-label="Pin ${escapeAttr(p.title)} for offline editing" aria-pressed="false" disabled>${icon('pinOff', 18)}</button>
    </td>
    <td class="rkr-admin-posts-action">
      <form method="post" action="/admin/posts/${slugUri}/delete" class="rkr-admin-posts-del" data-title="${escapeAttr(p.title)}">
        <button type="submit" class="rkr-admin-posts-del-btn" aria-label="Delete ${escapeAttr(p.title)}">${icon('trash2', 18)}</button>
      </form>
    </td>
  </tr>`;
}

/** Renders the tag rail aside. Returns empty string when tagCounts is
 * absent or empty — callers can splice the result directly into the
 * HTML without a wrapper conditional. */
function renderTagRail(
  tagCounts: { name: string; count: number }[] | undefined,
  activeTag: string | undefined
): string {
  if (!tagCounts || tagCounts.length === 0) return '';
  const clearLink = activeTag ? `\n  <a class="rkr-tag-clear" href="/">clear</a>` : '';
  const pills = tagCounts
    .map((t) => {
      const href = `/?tag=${encodeURIComponent(t.name)}`;
      const isActive = t.name === activeTag;
      const current = isActive ? ' aria-current="page"' : '';
      return `  <a class="rkr-tag-pill" href="${escapeAttr(href)}"${current}>${escapeText(t.name)} (${t.count})</a>`;
    })
    .join('\n');
  return `<aside class="rkr-tag-rail" aria-label="Tags">${clearLink}
${pills}
</aside>`;
}

/** Sort toggle.
 * Admin view: a client-side button (posts-list.js sorts the table without a reload).
 * Anonymous view: a link that adds/removes ?sort=asc via server-side requery. */
function renderSortToggle(
  isAsc: boolean,
  activeTag: string | undefined,
  isAdmin: boolean | undefined
): string {
  if (isAdmin) {
    // Button sorts the table client-side without a reload.
    // data-sort-dir reflects the current server-rendered order so the
    // first click always flips to the opposite direction.
    const dir = isAsc ? 'asc' : 'desc';
    const label = isAsc ? 'newest first' : 'oldest first';
    return `<button class="rkr-sort-toggle" data-sort-toggle data-sort-dir="${dir}">${icon('arrowUpDown', 14)} ${label}</button>\n`;
  }
  const tagPart = activeTag ? `tag=${encodeURIComponent(activeTag)}&amp;` : '';
  if (isAsc) {
    const href = activeTag ? `/?tag=${encodeURIComponent(activeTag)}` : '/';
    return `<a class="rkr-sort-toggle" href="${escapeAttr(href)}">newest first</a>\n`;
  }
  return `<a class="rkr-sort-toggle" href="/?${tagPart}sort=asc">oldest first</a>\n`;
}
