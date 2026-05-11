// Index page template. Doubles as the admin posts list when the
// visitor is authed (drafts join published, per-row status / pin /
// delete affordances appear). Anonymous view stays the plain
// reverse-chrono list of published titles.
//
// Combining the two pages means an admin lands directly on a fully-
// editable list — no separate "Posts" tab to discover, the homepage
// IS the dashboard.

import { escapeAttr, escapeText } from '../lib/content.ts';
import { bundleVersion, type SiteChrome, siteFoot, siteHead, stylesheetLinks } from './layout.ts';

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
  /** Logged-in admin → render the admin strip in siteHead and the
   * full posts table (drafts + status / pin / delete). */
  isAdmin?: boolean;
}

export function renderIndexPage(data: IndexPageData): string {
  const v = bundleVersion();
  const body = data.isAdmin ? renderAdminTable(data.posts) : renderAnonymousList(data.posts);
  const pager =
    data.totalPages > 1
      ? `<nav aria-label="pagination">
  <span>page ${data.page} of ${data.totalPages}</span>
  ${data.page > 1 ? `<a rel="prev" href="/?page=${data.page - 1}">prev</a>` : ''}
  ${data.page < data.totalPages ? `<a rel="next" href="/?page=${data.page + 1}">next</a>` : ''}
</nav>`
      : '';
  // The posts-list bundle wires status-select auto-submit + pin/unpin
  // OPFS lookups. Only emit it for the admin view — anonymous visitors
  // never see those controls.
  const postsListScript = data.isAdmin
    ? '<script type="module" src="/static/admin/posts-list.js"></script>'
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
<main id="main" tabindex="-1">
<h1 class="rkr-index-heading">${escapeText(data.site.title)}</h1>
${body}
${pager}
</main>
${siteFoot(data.site, { isAdmin: data.isAdmin })}
${postsListScript}
</body>
</html>
`;
}

function renderAnonymousList(posts: IndexEntry[]): string {
  const items = posts
    .map((p) => {
      const dateBlock = p.date
        ? `<time datetime="${escapeAttr(p.date)}">${escapeText(p.date)}</time>`
        : /* c8 ignore next -- runReindex always supplies published_at on listed posts */ '';
      return `  <li>${dateBlock}<a href="/${escapeAttr(p.slug)}">${escapeText(p.title)}</a></li>`;
    })
    .join('\n');
  return `<ul class="post-list">
${items}
</ul>`;
}

function renderAdminTable(posts: IndexEntry[]): string {
  if (posts.length === 0) {
    return `<table class="rkr-admin-posts">
  <thead><tr><th>Title</th><th>Updated</th><th class="rkr-admin-posts-action">Status</th><th class="rkr-admin-posts-action">Pin</th><th class="rkr-admin-posts-action">Delete</th></tr></thead>
  <tbody>
    <tr><td colspan="5" class="rkr-admin-posts-empty">No posts yet. <a href="/admin/editor">Create one</a>.</td></tr>
  </tbody>
</table>`;
  }
  return `<table class="rkr-admin-posts">
  <thead>
    <tr>
      <th>Title</th>
      <th>Updated</th>
      <th class="rkr-admin-posts-action">Status</th>
      <th class="rkr-admin-posts-action">Pin</th>
      <th class="rkr-admin-posts-action">Delete</th>
    </tr>
  </thead>
  <tbody>
${posts.map(renderAdminRow).join('\n')}
  </tbody>
</table>`;
}

function renderAdminRow(p: IndexEntry): string {
  const date = (p.updatedAt ?? p.date ?? '').slice(0, 10);
  const datetime = p.updatedAt ?? p.date ?? '';
  const slugUri = encodeURIComponent(p.slug);
  const status = p.status ?? 'draft';
  return `  <tr data-slug="${escapeAttr(p.slug)}">
    <td><a href="/${escapeAttr(p.slug)}">${escapeText(p.title)}</a></td>
    <td>${datetime ? `<time datetime="${escapeAttr(datetime)}">${escapeText(date)}</time>` : ''}</td>
    <td class="rkr-admin-posts-action">
      <form method="post" action="/admin/posts/${slugUri}/status" class="rkr-admin-posts-status-form">
        <label class="rkr-vh" for="rkr-status-${escapeAttr(p.slug)}">Status for ${escapeAttr(p.title)}</label>
        <select id="rkr-status-${escapeAttr(p.slug)}" name="status" class="rkr-admin-posts-status is-${status}">
          <option value="draft"${status === 'draft' ? ' selected' : ''}>draft</option>
          <option value="published"${status === 'published' ? ' selected' : ''}>published</option>
        </select>
        <noscript><button type="submit">apply</button></noscript>
      </form>
    </td>
    <td class="rkr-admin-posts-action">
      <button type="button" class="rkr-admin-posts-pin" data-pin-toggle aria-label="Pin ${escapeAttr(p.title)} for offline editing" aria-pressed="false" disabled>pin</button>
    </td>
    <td class="rkr-admin-posts-action">
      <form method="post" action="/admin/posts/${slugUri}/delete" class="rkr-admin-posts-del">
        <button type="submit" class="rkr-admin-posts-del-btn" aria-label="Delete ${escapeAttr(p.title)}">delete</button>
      </form>
    </td>
  </tr>`;
}
