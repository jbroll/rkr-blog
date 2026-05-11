// Admin posts list. Renders all posts (drafts + published) with edit
// + delete affordances; the public /:slug index only shows published
// so drafts would be unreachable without this surface.
//
// Uses the public siteHead/siteFoot so themes apply here too.

import { escapeAttr, escapeText } from '../lib/content.ts';
import { type SiteChrome, siteFoot, siteHead, stylesheetLinks } from './layout.ts';

interface AdminPostRow {
  slug: string;
  title: string;
  status: 'draft' | 'published';
  /** ISO timestamp; rendered as a yyyy-mm-dd date for the row. */
  updatedAt: string;
}

export interface AdminPostsPageData extends SiteChrome {
  posts: AdminPostRow[];
}

export function renderAdminPostsPage(data: AdminPostsPageData): string {
  const rows = data.posts.length === 0 ? renderEmptyState() : data.posts.map(renderRow).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Posts — ${escapeText(data.site.title)}</title>
${stylesheetLinks()}
</head>
<body>
${siteHead(data.site, { isAdmin: true })}
<main id="main" tabindex="-1">
<h1 class="rkr-admin-posts-heading">All posts</h1>
<table class="rkr-admin-posts">
  <thead>
    <tr><th>Title</th><th>Status</th><th>Updated</th><th class="rkr-admin-posts-actions">Actions</th></tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>
</main>
${siteFoot(data.site)}
<script type="module" src="/static/admin/posts-list.js"></script>
</body>
</html>
`;
}

function renderRow(p: AdminPostRow): string {
  // delete + status are both <form method="post"> so the CSRF /
  // Origin guard fires and a no-JS browser still works — the small
  // posts-list bundle just submits the status form on select-change
  // for a smoother flow.
  const date = p.updatedAt.slice(0, 10);
  const slugUri = encodeURIComponent(p.slug);
  return `  <tr data-slug="${escapeAttr(p.slug)}">
    <td><a href="/${escapeAttr(p.slug)}">${escapeText(p.title)}</a></td>
    <td>
      <form method="post" action="/admin/posts/${slugUri}/status" class="rkr-admin-posts-status-form">
        <label class="rkr-vh" for="rkr-status-${escapeAttr(p.slug)}">Status for ${escapeAttr(p.title)}</label>
        <select id="rkr-status-${escapeAttr(p.slug)}" name="status" class="rkr-admin-posts-status is-${p.status}">
          <option value="draft"${p.status === 'draft' ? ' selected' : ''}>draft</option>
          <option value="published"${p.status === 'published' ? ' selected' : ''}>published</option>
        </select>
        <noscript><button type="submit">apply</button></noscript>
      </form>
    </td>
    <td><time datetime="${escapeAttr(p.updatedAt)}">${escapeText(date)}</time></td>
    <td class="rkr-admin-posts-actions">
      <a class="rkr-admin-posts-edit" href="/admin/editor?slug=${slugUri}">edit</a>
      <button type="button" class="rkr-admin-posts-pin" data-pin-toggle aria-label="Pin ${escapeAttr(p.title)} for offline editing" aria-pressed="false" disabled>pin</button>
      <form method="post" action="/admin/posts/${slugUri}/delete" class="rkr-admin-posts-del">
        <button type="submit" class="rkr-admin-posts-del-btn" aria-label="Delete ${escapeAttr(p.title)}">delete</button>
      </form>
    </td>
  </tr>`;
}

function renderEmptyState(): string {
  return `  <tr><td colspan="4" class="rkr-admin-posts-empty">No posts yet. <a href="/admin/editor">Create one</a>.</td></tr>`;
}
