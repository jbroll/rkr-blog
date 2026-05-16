// Server-rendered moderation page. No SPA bundle — plain form POSTs so
// it works with the existing admin auth (cookie or bearer) and the
// strict CSP. Queued first (the backlog), then recent published.

import type { ModerationRow } from '../lib/comments.ts';
import { escapeAttr, escapeText } from '../lib/content.ts';
import { type SiteChrome, siteHead, stylesheetLinks } from './layout.ts';

function row(c: ModerationRow): string {
  const score = c.spam_score === null ? '' : ` · spam ${(c.spam_score * 100).toFixed(0)}%`;
  const reason = c.spam_reason ? ` · ${escapeText(c.spam_reason)}` : '';
  const actions =
    c.status === 'queued'
      ? `<form method="POST" action="/admin/comments/${c.id}/approve"><button>Approve</button></form>
<form method="POST" action="/admin/comments/${c.id}/reject"><button>Reject</button></form>`
      : `<form method="POST" action="/admin/comments/${c.id}/delete"><button>Delete</button></form>`;
  return `<li class="amc-row amc-${escapeAttr(c.status)}">
<div class="amc-meta">#${c.id} · ${escapeText(c.author_name)} · /${escapeText(
    c.post_slug
  )} · ${escapeText(c.created_at.slice(0, 10))} · <strong>${escapeText(
    c.status
  )}</strong>${escapeText(score)}${reason}</div>
<div class="amc-body">${escapeText(c.body)}</div>
<div class="amc-actions">${actions}</div>
</li>`;
}

export function renderAdminCommentsPage(rows: ModerationRow[], site: SiteChrome['site']): string {
  const list =
    rows.length === 0
      ? '<p>No comments.</p>'
      : `<ol class="amc-list">${rows.map(row).join('')}</ol>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Comment moderation</title>
${stylesheetLinks()}
</head><body>
${siteHead(site, { isAdmin: true })}
<main class="amc-wrap" id="main">
<h1>Comment moderation</h1>
${list}
</main>
</body></html>`;
}
