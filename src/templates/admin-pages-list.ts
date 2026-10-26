import { escapeAttr, escapeText } from '../lib/content.ts';

export interface PageRow {
  slug: string;
  title: string;
  status: 'draft' | 'published';
  /** ISO timestamp of the last change. */
  updatedAt: string;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} ago`;

/** "3 hours ago" style text; dates older than 8 weeks fall back to "Mar 4, 2025". */
export function relativeDate(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const age = Math.max(0, now - then);
  if (age < MIN) return 'just now';
  if (age < HOUR) return plural(Math.floor(age / MIN), 'minute');
  if (age < DAY) return plural(Math.floor(age / HOUR), 'hour');
  if (age < 2 * DAY) return 'yesterday';
  if (age < 14 * DAY) return plural(Math.floor(age / DAY), 'day');
  if (age < 56 * DAY) return plural(Math.floor(age / (7 * DAY)), 'week');
  return new Date(then).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

// Colors come from the active theme's --rkr-* tokens so the list sits
// in the same chrome as the editor.
export const PAGES_LIST_CSS = `
.rkr-pages{--pg-border:color-mix(in srgb,var(--rkr-rule) 78%,var(--rkr-text));--pg-surface:color-mix(in srgb,var(--rkr-bg) 94%,var(--rkr-text));font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.rkr-pages-head{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem 1rem;margin:0 0 1rem}
.rkr-pages-head h1{flex:1 1 auto;margin:0}
.rkr-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.rkr-pages-filter{display:flex;flex:1 1 14rem;max-width:20rem;margin:0}
.rkr-pages-filter input{box-sizing:border-box;width:100%;min-height:2.5rem;margin:0;padding:.45rem .75rem;font:inherit;font-size:.9375rem;color:var(--rkr-text);background:var(--rkr-bg);border:1px solid var(--pg-border);border-radius:6px}
.rkr-pages-new{display:inline-flex;align-items:center;min-height:2.5rem;padding:.45rem 1.1rem;font-size:.9375rem;font-weight:600;text-decoration:none;color:var(--rkr-bg);background:var(--rkr-link);border:1px solid var(--rkr-link);border-radius:6px}
.rkr-pages-new:hover{background:color-mix(in srgb,var(--rkr-link) 86%,#000)}
.rkr-pages :is(a,input):focus-visible{outline:2px solid var(--rkr-link);outline-offset:2px}
.rkr-pages-table{width:100%;border-collapse:collapse;font-size:.9375rem}
.rkr-pages-table th{padding:.5rem .75rem;text-align:left;font-size:.8125rem;font-weight:600;color:var(--rkr-muted);border-bottom:1px solid var(--pg-border)}
.rkr-pages-table td{padding:.75rem;vertical-align:middle;border-bottom:1px solid var(--pg-border)}
.rkr-pages-table tbody tr:hover{background:var(--pg-surface)}
.rkr-pages-title{display:block;font-weight:600;color:var(--rkr-text)}
.rkr-pages-slug{display:block;font-size:.8125rem;color:var(--rkr-muted)}
.rkr-status{display:inline-flex;align-items:center;gap:.4rem;padding:.15rem .6rem;font-size:.8125rem;font-weight:500;border:1px solid var(--pg-border);border-radius:999px}
.rkr-status::before{content:"";width:.5rem;height:.5rem;border-radius:50%;background:var(--rkr-muted)}
.rkr-status--published{color:var(--rkr-text)}
.rkr-status--published::before{background:#2e7d4f}
.rkr-status--draft{color:var(--rkr-muted)}
.rkr-pages-updated{color:var(--rkr-muted);white-space:nowrap}
.rkr-pages-links{display:flex;gap:1rem;justify-content:flex-end;white-space:nowrap}
.rkr-pages-links a{font-weight:500;color:var(--rkr-link)}
.rkr-pages-empty{margin:2rem 0;padding:2rem 1rem;text-align:center;color:var(--rkr-muted);border:1px dashed var(--pg-border);border-radius:6px}
.rkr-pages-empty p{margin:0 0 1rem}
@media (max-width:600px){
.rkr-pages-filter{max-width:none;flex-basis:100%}
.rkr-pages-new{justify-content:center;flex:1 1 100%}
.rkr-pages-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.rkr-pages-table,.rkr-pages-table tbody{display:block}
.rkr-pages-table tr{display:grid;grid-template-columns:auto 1fr;gap:.35rem .75rem;align-items:center;padding:.75rem 0;border-bottom:1px solid var(--pg-border)}
.rkr-pages-table td{padding:0;border:0}
.rkr-pages-table td:first-child{grid-column:1/-1}
.rkr-pages-actions{grid-column:1/-1}
.rkr-pages-links{justify-content:flex-start;gap:1.5rem}
.rkr-pages-links a{display:inline-flex;align-items:center;min-height:2.5rem}
}
`;

function row(p: PageRow, now: number): string {
  const slug = escapeAttr(p.slug);
  const label = p.status === 'published' ? 'Published' : 'Draft';
  return `<tr>
<td><span class="rkr-pages-title">${escapeText(p.title)}</span><span class="rkr-pages-slug">/${escapeText(p.slug)}</span></td>
<td><span class="rkr-status rkr-status--${p.status}">${label}</span></td>
<td class="rkr-pages-updated"><time datetime="${escapeAttr(p.updatedAt)}" title="${escapeAttr(p.updatedAt)}">${escapeText(relativeDate(p.updatedAt, now))}</time></td>
<td class="rkr-pages-actions"><span class="rkr-pages-links"><a href="/admin/blocks/edit/${slug}">Edit</a><a href="/pages/${slug}">View</a></span></td>
</tr>`;
}

/** Admin pages list: a filterable table, or an empty state. `total` is
 * the unfiltered count, so an empty filter result reads differently
 * from an empty site. */
export function renderAdminPagesIndex(
  rows: PageRow[],
  opts: { q?: string; total: number; now?: number }
): string {
  const now = opts.now ?? Date.now();
  const q = opts.q ?? '';
  const newLink = '<a class="rkr-pages-new" href="/admin/blocks/new">New page</a>';
  let content: string;
  if (opts.total === 0) {
    content = `<div class="rkr-pages-empty"><p>No pages yet. Create your first page.</p>${newLink}</div>`;
  } else if (rows.length === 0) {
    content = `<div class="rkr-pages-empty"><p>No pages match “${escapeText(q)}”.</p></div>`;
  } else {
    content = `<table class="rkr-pages-table">
<thead><tr><th scope="col">Title</th><th scope="col">Status</th><th scope="col">Updated</th><th scope="col"><span class="rkr-sr">Actions</span></th></tr></thead>
<tbody>
${rows.map((r) => row(r, now)).join('\n')}
</tbody>
</table>`;
  }
  const head = `<div class="rkr-pages-head"><h1>Pages</h1>
<form class="rkr-pages-filter" method="get" action="/admin/blocks" role="search"><input type="search" name="q" value="${escapeAttr(q)}" placeholder="Filter by title" aria-label="Filter by title"/></form>
${opts.total === 0 ? '' : newLink}</div>`;
  return `<div class="rkr-pages">\n${head}\n${content}\n</div>\n`;
}
